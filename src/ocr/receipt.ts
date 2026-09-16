import { z } from 'zod'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DOCUMENT_AI_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])

export const receiptSchema = z.object({
  merchant: z.string().nullable(),
  purchasedAt: z.string().nullable(),
  total: z.number().nonnegative().nullable(),
  tax: z.number().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  items: z.array(z.object({
    name: z.string(),
    quantity: z.number().positive().nullable(),
    amount: z.number().nonnegative().nullable(),
  })),
})

export type ReceiptExtraction = z.infer<typeof receiptSchema>
export type DocumentAiConfig = {
  projectId: string
  location: 'us' | 'eu'
  processorId: string
  processorVersion?: string
  serviceAccountEmail: string
  serviceAccountPrivateKey: string
}
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class OcrInputError extends Error {}
export class OcrConfigurationError extends Error {}
export class DocumentAiRequestError extends Error {}

function hasValidSignature(type: string, bytes: Uint8Array) {
  if (type === 'image/png') return bytes.length >= 8 && bytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (type === 'image/webp') return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  const header = new TextDecoder().decode(bytes.slice(0, 64))
  return bytes.length >= 12 && header.slice(4, 8) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1/.test(header)
}

function toBase64(bytes: Uint8Array) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

function base64UrlEncode(value: string | Uint8Array) {
  const binary = typeof value === 'string' ? value : Array.from(value, (byte) => String.fromCharCode(byte)).join('')
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function pemToPkcs8(privateKey: string) {
  const encoded = privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')
  if (!encoded) throw new OcrConfigurationError('Document AI のサービスアカウント鍵が不正です。')
  try {
    return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  } catch {
    throw new OcrConfigurationError('Document AI のサービスアカウント鍵が不正です。')
  }
}

function matches(value: string | undefined, pattern: RegExp) {
  return Boolean(value && pattern.test(value))
}

export function validateDocumentAiConfig(config: Partial<DocumentAiConfig>): DocumentAiConfig {
  if (!matches(config.projectId, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)) throw new OcrConfigurationError('Document AI のプロジェクト設定が不正です。')
  if (config.location !== 'us' && config.location !== 'eu') throw new OcrConfigurationError('Document AI のリージョンは us または eu を指定してください。')
  if (!matches(config.processorId, /^[A-Za-z0-9-]{1,128}$/)) throw new OcrConfigurationError('Document AI のプロセッサ設定が不正です。')
  if (config.processorVersion && !matches(config.processorVersion, /^[A-Za-z0-9-]{1,128}$/)) throw new OcrConfigurationError('Document AI のプロセッサバージョン設定が不正です。')
  if (!config.serviceAccountEmail || !config.serviceAccountPrivateKey) throw new OcrConfigurationError('OCR はまだ設定されていません。')
  return {
    projectId: config.projectId!,
    location: config.location,
    processorId: config.processorId!,
    processorVersion: config.processorVersion,
    serviceAccountEmail: config.serviceAccountEmail!,
    serviceAccountPrivateKey: config.serviceAccountPrivateKey!,
  }
}

export async function getServiceAccountAccessToken(config: DocumentAiConfig, fetchImpl: FetchLike, now = Date.now(), signal?: AbortSignal) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64UrlEncode(JSON.stringify({
    iss: config.serviceAccountEmail,
    scope: DOCUMENT_AI_SCOPE,
    aud: TOKEN_URL,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600,
  }))
  const signingInput = `${header}.${payload}`
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(config.serviceAccountPrivateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  } catch (error) {
    if (error instanceof OcrConfigurationError) throw error
    throw new OcrConfigurationError('Document AI のサービスアカウント鍵が不正です。')
  }
  let signature: Uint8Array
  try {
    signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput)))
  } catch {
    throw new OcrConfigurationError('Document AI のサービスアカウント鍵が不正です。')
  }
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${signingInput}.${base64UrlEncode(signature)}` }),
    signal,
  })
  if (!response.ok) throw new DocumentAiRequestError('Document AI の認証に失敗しました。')
  const result = await response.json() as { access_token?: unknown }
  if (typeof result.access_token !== 'string' || !result.access_token) throw new DocumentAiRequestError('Document AI の認証結果が不正です。')
  return result.access_token
}

type DocumentAiEntity = {
  type?: unknown
  mentionText?: unknown
  normalizedValue?: {
    moneyValue?: { currencyCode?: unknown; units?: unknown; nanos?: unknown }
    dateValue?: { year?: unknown; month?: unknown; day?: unknown }
    text?: unknown
  }
  properties?: DocumentAiEntity[]
}

function entityText(entity: DocumentAiEntity | undefined) {
  const normalized = entity?.normalizedValue?.text
  if (typeof normalized === 'string' && normalized.trim()) return normalized.trim()
  return typeof entity?.mentionText === 'string' && entity.mentionText.trim() ? entity.mentionText.trim() : null
}

function entityMoney(entity: DocumentAiEntity | undefined) {
  const money = entity?.normalizedValue?.moneyValue
  if (!money) return { amount: null, currency: null }
  const units = typeof money.units === 'string' || typeof money.units === 'number' ? Number(money.units) : NaN
  const nanos = typeof money.nanos === 'number' ? money.nanos : Number(money.nanos ?? 0)
  const amount = Number.isSafeInteger(units) && Number.isInteger(nanos) ? units + nanos / 1_000_000_000 : null
  return {
    amount: amount !== null && Number.isFinite(amount) && amount >= 0 ? amount : null,
    currency: typeof money.currencyCode === 'string' && /^[A-Z]{3}$/.test(money.currencyCode) ? money.currencyCode : null,
  }
}

function formatValidDate(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day))
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function entityDate(entity: DocumentAiEntity | undefined) {
  const date = entity?.normalizedValue?.dateValue
  if (typeof date?.year === 'number' && typeof date.month === 'number' && typeof date.day === 'number') return formatValidDate(date.year, date.month, date.day)
  const mention = entityText(entity)
  if (!mention || !/^\d{4}-\d{2}-\d{2}$/.test(mention)) return null
  return formatValidDate(Number(mention.slice(0, 4)), Number(mention.slice(5, 7)), Number(mention.slice(8, 10)))
}

function firstEntity(entities: DocumentAiEntity[], type: string) {
  return entities.find((entity) => entity.type === type)
}

function propertyBySuffix(entity: DocumentAiEntity, suffix: string) {
  return entity.properties?.find((property) => typeof property.type === 'string' && (property.type === suffix || property.type.endsWith(`/${suffix}`)))
}

export function mapExpenseDocument(document: { entities?: unknown }): ReceiptExtraction {
  const entities = Array.isArray(document.entities) ? document.entities.filter((entity): entity is DocumentAiEntity => Boolean(entity && typeof entity === 'object')) : []
  const total = entityMoney(firstEntity(entities, 'total_amount'))
  const tax = entityMoney(firstEntity(entities, 'total_tax_amount'))
  const currency = entityText(firstEntity(entities, 'currency'))
  const items = entities.filter((entity) => entity.type === 'line_item').flatMap((entity) => {
    const name = entityText(propertyBySuffix(entity, 'description'))
    if (!name) return []
    return [{ name, quantity: null, amount: entityMoney(propertyBySuffix(entity, 'amount')).amount }]
  })
  return receiptSchema.parse({
    merchant: entityText(firstEntity(entities, 'supplier_name')),
    purchasedAt: entityDate(firstEntity(entities, 'receipt_date')),
    total: total.amount,
    tax: tax.amount,
    currency: total.currency ?? (currency && /^[A-Z]{3}$/.test(currency) ? currency : null),
    items,
  })
}

export async function extractReceiptWithDocumentAi(file: File, config: DocumentAiConfig, fetchImpl: FetchLike = fetch, now = Date.now(), signal = AbortSignal.timeout(20_000)): Promise<ReceiptExtraction> {
  if (!supportedImageTypes.has(file.type)) throw new OcrInputError('PNG、JPEG、WebP の画像を選択してください。')
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new OcrInputError('画像は 1 バイト以上 8 MB 以下にしてください。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!hasValidSignature(file.type, bytes)) throw new OcrInputError('画像形式を確認できませんでした。')

  const accessToken = await getServiceAccountAccessToken(config, fetchImpl, now, signal)
  const processorPath = config.processorVersion ? `processors/${config.processorId}/processorVersions/${config.processorVersion}` : `processors/${config.processorId}`
  const endpoint = `https://${config.location}-documentai.googleapis.com/v1/projects/${config.projectId}/locations/${config.location}/${processorPath}:process`
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ rawDocument: { content: toBase64(bytes), mimeType: file.type }, skipHumanReview: true }),
    signal,
  })
  if (!response.ok) throw new DocumentAiRequestError('Document AI の読み取りに失敗しました。')
  const result = await response.json() as { document?: unknown }
  if (!result.document || typeof result.document !== 'object') throw new DocumentAiRequestError('Document AI の読み取り結果が不正です。')
  return mapExpenseDocument(result.document as { entities?: unknown })
}
