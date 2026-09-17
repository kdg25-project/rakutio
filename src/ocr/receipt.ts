import { z } from 'zod'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_ERROR_RESPONSE_BYTES = 4 * 1024
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DOCUMENT_AI_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])

export const receiptSchema = z.object({
  merchant: z.string().nullable(),
  purchasedAt: z.string().nullable(),
  total: z.number().nonnegative().nullable(),
  tax: z.number().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  // Older saved analyses predate this field, so retain optionality while
  // allowing fresh Document AI results to carry the detected method through
  // to the editable draft.
  paymentMethod: z.string().min(1).max(50).nullable().optional(),
  items: z.array(z.object({
    name: z.string(),
    quantity: z.number().positive().nullable(),
    amount: z.number().nonnegative().nullable(),
    // Added after OCR by the optional category classifier. Document AI itself
    // never supplies an application category ID.
    categoryId: z.string().min(1).optional(),
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
export type DocumentAiRequestStage = 'authentication' | 'processing'

export type DocumentAiErrorCode =
  | 'DOCUMENT_AI_AUTHENTICATION_FAILED'
  | 'DOCUMENT_AI_AUTH_NETWORK_ERROR'
  | 'DOCUMENT_AI_AUTH_TIMEOUT'
  | 'DOCUMENT_AI_ENDPOINT_UNAVAILABLE'
  | 'DOCUMENT_AI_INVALID_ARGUMENT'
  | 'DOCUMENT_AI_INVALID_RESPONSE'
  | 'DOCUMENT_AI_NETWORK_ERROR'
  | 'DOCUMENT_AI_PERMISSION_DENIED'
  | 'DOCUMENT_AI_PROCESSOR_NOT_FOUND'
  | 'DOCUMENT_AI_QUOTA_EXCEEDED'
  | 'DOCUMENT_AI_REQUEST_FAILED'
  | 'DOCUMENT_AI_SERVICE_UNAVAILABLE'
  | 'DOCUMENT_AI_TIMEOUT'
  | 'DOCUMENT_AI_UNAUTHORIZED'

export type GoogleErrorStatus =
  | 'ABORTED'
  | 'ALREADY_EXISTS'
  | 'CANCELLED'
  | 'DATA_LOSS'
  | 'DEADLINE_EXCEEDED'
  | 'FAILED_PRECONDITION'
  | 'INTERNAL'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'OK'
  | 'OUT_OF_RANGE'
  | 'PERMISSION_DENIED'
  | 'RESOURCE_EXHAUSTED'
  | 'UNAUTHENTICATED'
  | 'UNAVAILABLE'
  | 'UNIMPLEMENTED'
  | 'UNKNOWN'

export class OcrInputError extends Error {}
export class OcrConfigurationError extends Error {}
export class DocumentAiRequestError extends Error {
  readonly name = 'DocumentAiRequestError'

  constructor(
    message: string,
    readonly code: DocumentAiErrorCode = 'DOCUMENT_AI_REQUEST_FAILED',
    readonly httpStatus: number | null = null,
    readonly googleStatus: GoogleErrorStatus | null = null,
    readonly googleCode: number | null = null,
    /** Safe request metadata for server logs. Never expose this to clients. */
    readonly stage: DocumentAiRequestStage | null = null,
    readonly transportErrorName: string | null = null,
  ) {
    super(message)
  }
}

type GoogleErrorPayload = {
  error?: {
    code?: unknown
    status?: unknown
    message?: unknown
  }
}

const googleErrorStatuses = new Set<GoogleErrorStatus>([
  'ABORTED', 'ALREADY_EXISTS', 'CANCELLED', 'DATA_LOSS', 'DEADLINE_EXCEEDED', 'FAILED_PRECONDITION', 'INTERNAL', 'INVALID_ARGUMENT', 'NOT_FOUND', 'OK', 'OUT_OF_RANGE', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'UNAUTHENTICATED', 'UNAVAILABLE', 'UNIMPLEMENTED', 'UNKNOWN',
])

async function readBoundedResponseText(response: Response) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < MAX_ERROR_RESPONSE_BYTES) {
      const { done, value } = await reader.read()
      if (done || !value) break
      const remaining = MAX_ERROR_RESPONSE_BYTES - size
      chunks.push(value.byteLength > remaining ? value.slice(0, remaining) : value)
      size += Math.min(value.byteLength, remaining)
      if (value.byteLength > remaining) {
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function parseGoogleError(body: string) {
  try {
    const payload = JSON.parse(body) as GoogleErrorPayload
    const error = payload && typeof payload === 'object' && payload.error && typeof payload.error === 'object' ? payload.error : null
    const status = typeof error?.status === 'string' && googleErrorStatuses.has(error.status as GoogleErrorStatus) ? error.status as GoogleErrorStatus : null
    return {
      code: typeof error?.code === 'number' && Number.isInteger(error.code) ? error.code : null,
      status,
      // Parse the message only to validate the expected Google shape. Do not
      // retain or display it: provider messages can include request details.
      message: typeof error?.message === 'string' ? error.message.slice(0, 512) : null,
    }
  } catch {
    return { code: null, status: null, message: null }
  }
}

function documentAiErrorForStatus(httpStatus: number, googleStatus: GoogleErrorStatus | null, googleCode: number | null) {
  if (httpStatus === 404 || googleStatus === 'NOT_FOUND') return new DocumentAiRequestError('読み取り設定が見つかりません。しばらくしても直らない場合は、管理者にプロセッサ設定の確認を依頼してください。', 'DOCUMENT_AI_PROCESSOR_NOT_FOUND', httpStatus, googleStatus, googleCode)
  if (httpStatus === 403 || googleStatus === 'PERMISSION_DENIED') return new DocumentAiRequestError('読み取りサービスへの権限がありません。管理者に Document AI の権限と API 有効化を確認してもらってください。', 'DOCUMENT_AI_PERMISSION_DENIED', httpStatus, googleStatus, googleCode)
  if (httpStatus === 401 || googleStatus === 'UNAUTHENTICATED') return new DocumentAiRequestError('読み取りサービスの認証に失敗しました。管理者に認証設定を確認してもらってください。', 'DOCUMENT_AI_UNAUTHORIZED', httpStatus, googleStatus, googleCode)
  if (httpStatus === 429 || googleStatus === 'RESOURCE_EXHAUSTED') return new DocumentAiRequestError('読み取りサービスが混み合っています。少し時間を置いてから再試行してください。', 'DOCUMENT_AI_QUOTA_EXCEEDED', httpStatus, googleStatus, googleCode)
  if (httpStatus === 400 || googleStatus === 'INVALID_ARGUMENT') return new DocumentAiRequestError('画像または読み取り設定を確認して、もう一度お試しください。', 'DOCUMENT_AI_INVALID_ARGUMENT', httpStatus, googleStatus, googleCode)
  if (httpStatus >= 500 || googleStatus === 'UNAVAILABLE' || googleStatus === 'INTERNAL') return new DocumentAiRequestError('読み取りサービスに一時的な問題があります。少し時間を置いてから再試行してください。', 'DOCUMENT_AI_SERVICE_UNAVAILABLE', httpStatus, googleStatus, googleCode)
  return new DocumentAiRequestError('読み取りサービスでエラーが発生しました。時間を置いてから再試行してください。', 'DOCUMENT_AI_REQUEST_FAILED', httpStatus, googleStatus, googleCode)
}

async function documentAiErrorFromResponse(response: Response) {
  const providerError = parseGoogleError(await readBoundedResponseText(response))
  return documentAiErrorForStatus(response.status, providerError.status, providerError.code)
}

function safeErrorName(error: unknown) {
  const name = error instanceof Error ? error.name : typeof error
  return /^[A-Za-z0-9_.-]{1,80}$/.test(name) ? name : 'UnknownError'
}

function documentAiTransportError(error: unknown, signal: AbortSignal, stage: DocumentAiRequestStage) {
  const errorName = safeErrorName(error)
  if (signal.aborted || errorName === 'AbortError' || errorName === 'TimeoutError') {
    if (stage === 'authentication') return new DocumentAiRequestError('読み取りサービスの認証がタイムアウトしました。時間を置いてから再試行してください。', 'DOCUMENT_AI_AUTH_TIMEOUT', null, null, null, stage, errorName)
    return new DocumentAiRequestError('読み取りがタイムアウトしました。通信状況を確認してから再試行してください。', 'DOCUMENT_AI_TIMEOUT', null, null, null, stage, errorName)
  }
  if (stage === 'authentication') return new DocumentAiRequestError('読み取りサービスの認証先に接続できませんでした。通信状況を確認してから再試行してください。', 'DOCUMENT_AI_AUTH_NETWORK_ERROR', null, null, null, stage, errorName)
  // A processor ID is part of the path, so an invalid ID is returned as a
  // typed 404 above. A fetch rejection here means the regional API endpoint
  // itself could not be reached (for example DNS/egress trouble), without
  // exposing the URL or the underlying provider error to the client.
  return new DocumentAiRequestError('読み取りサービスの接続先に到達できませんでした。管理者に Document AI のリージョン設定とサービスの接続状況を確認してもらってください。', 'DOCUMENT_AI_ENDPOINT_UNAVAILABLE', null, null, null, stage, errorName)
}

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
  const requestSignal = signal ?? AbortSignal.timeout(20_000)
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
  let response: Response
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${signingInput}.${base64UrlEncode(signature)}` }),
      signal: requestSignal,
    })
  } catch (error) {
    throw documentAiTransportError(error, requestSignal, 'authentication')
  }
  if (!response.ok) throw new DocumentAiRequestError('Document AI の認証に失敗しました。管理者に認証設定を確認してもらってください。', 'DOCUMENT_AI_AUTHENTICATION_FAILED', response.status)
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

function entityMoney(entity: DocumentAiEntity | undefined, allowTextFallback = false) {
  const money = entity?.normalizedValue?.moneyValue
  if (money) {
    const units = typeof money.units === 'string' || typeof money.units === 'number' ? Number(money.units) : NaN
    const nanos = typeof money.nanos === 'number' ? money.nanos : Number(money.nanos ?? 0)
    const amount = Number.isSafeInteger(units) && Number.isInteger(nanos) ? units + nanos / 1_000_000_000 : null
    return {
      amount: amount !== null && Number.isFinite(amount) && amount >= 0 ? amount : null,
      currency: typeof money.currencyCode === 'string' && /^[A-Z]{3}$/.test(money.currencyCode) ? money.currencyCode : null,
    }
  }

  // Expense Parser sometimes returns a line-item amount as only mentionText
  // (for example `¥1,100`) or normalizedValue.text, while total_amount still
  // has a normalized moneyValue. Keep those valid OCR values instead of
  // turning them into an empty amount field in the draft editor.
  if (!allowTextFallback) return { amount: null, currency: null }

  const text = entityText(entity)
  const normalized = text?.replaceAll('０', '0').replaceAll('１', '1').replaceAll('２', '2').replaceAll('３', '3').replaceAll('４', '4').replaceAll('５', '5').replaceAll('６', '6').replaceAll('７', '7').replaceAll('８', '8').replaceAll('９', '9').replaceAll('，', ',')
  // A line item can contain both a quantity and a price (for example
  // `1 x ¥1,100`). Prefer the value immediately following a currency mark;
  // otherwise use the final number, which is how the Expense Parser renders
  // its text-only line-item amount in practice. This fallback is deliberately
  // used only for a property already identified as a line-item price below.
  const currencyNumber = normalized?.match(/[¥￥$€£]\s*([\d][\d,]*(?:\.\d+)?)/)?.[1]
  const numbers = normalized?.match(/\d[\d,]*(?:\.\d+)?/g)
  const normalizedNumber = currencyNumber ?? numbers?.at(-1)
  const parsed = normalizedNumber ? Number(normalizedNumber.replaceAll(',', '')) : NaN
  return {
    amount: Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null,
    currency: null,
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

function firstEntityOfTypes(entities: DocumentAiEntity[], types: readonly string[]) {
  return entities.find((entity) => typeof entity.type === 'string' && types.includes(entity.type))
}

type NestedProperty = { entity: DocumentAiEntity; depth: number; order: number }

/**
 * Expense Parser normally puts `line_item/amount` directly in a line item's
 * properties. Some processor versions wrap it in another property group
 * instead (for example `line_item/line_item/amount`). Search only within that
 * line item so a receipt-level total can never become an item price.
 */
function nestedProperties(entity: DocumentAiEntity) {
  const found: NestedProperty[] = []
  const seen = new Set<object>()
  let order = 0

  const visit = (properties: unknown, depth: number) => {
    if (!Array.isArray(properties)) return
    for (const property of properties) {
      if (!property || typeof property !== 'object' || seen.has(property)) continue
      seen.add(property)
      const value = property as DocumentAiEntity
      found.push({ entity: value, depth, order: order++ })
      visit(value.properties, depth + 1)
    }
  }

  visit(entity.properties, 1)
  return found
}

function propertyType(entity: DocumentAiEntity) {
  return typeof entity.type === 'string' ? entity.type.trim().toLowerCase() : ''
}

function propertyHasSuffix(entity: DocumentAiEntity, suffix: string) {
  const type = propertyType(entity)
  return type === suffix || type.endsWith(`/${suffix}`)
}

function firstNestedPropertyBySuffix(entity: DocumentAiEntity, suffix: string) {
  return nestedProperties(entity)
    .filter((property) => propertyHasSuffix(property.entity, suffix) && entityText(property.entity))
    .sort((left, right) => left.depth - right.depth || left.order - right.order)[0]?.entity
}

function lineItemAmountRank(entity: DocumentAiEntity) {
  const type = propertyType(entity)
  if (!type) return null
  const part = type.split('/').at(-1)
  if (part === 'amount') return 0
  if (part === 'total_amount' || part === 'total_price' || part === 'line_total' || part === 'extended_price') return 1
  if (part === 'price' || part === 'unit_price' || part === 'item_price') return 2
  // Some Expense Parser versions wrap a line's quantity and amount in an
  // unnamed nested `line_item` entity. It is a weaker fallback than an
  // explicit amount/price property, and is parsed only when its own text is
  // made entirely of numbers and layout punctuation (see below).
  if (part === 'line_item') return 3
  return null
}

function nestedLineItemAmount(entity: DocumentAiEntity) {
  const text = entityText(entity)
  if (!text) return { amount: null, currency: null }

  const normalized = text
    .replaceAll('０', '0').replaceAll('１', '1').replaceAll('２', '2').replaceAll('３', '3').replaceAll('４', '4')
    .replaceAll('５', '5').replaceAll('６', '6').replaceAll('７', '7').replaceAll('８', '8').replaceAll('９', '9')
    .replaceAll('，', ',').replaceAll('．', '.')
  // Do not treat a product name such as "500ml" as its price. A nested
  // line-item fallback is permitted only for an amount-shaped mention, e.g.
  // "(1 1,100 1,100)" or "(600 1)" returned by the Expense Parser.
  if (/[^\d\s,().¥￥$€£×xX]/.test(normalized)) return { amount: null, currency: null }

  const numbers = normalized.match(/\d[\d,]*(?:\.\d+)?/g)
    ?.map((value) => Number(value.replaceAll(',', '')))
    .filter((value) => Number.isSafeInteger(value) && value >= 0) ?? []
  if (!numbers.length) return { amount: null, currency: null }

  // Parser grouping text can order this as either "1 600" or "600 1".
  // The line amount is the largest safe integer in that constrained shape;
  // explicit amount/price entities remain preferred by lineItemAmount.
  return { amount: Math.max(...numbers), currency: null }
}

function lineItemAmount(entity: DocumentAiEntity) {
  const candidates = nestedProperties(entity)
    .map((property) => ({ ...property, rank: lineItemAmountRank(property.entity) }))
    .filter((property): property is NestedProperty & { rank: number } => property.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.depth - right.depth || left.order - right.order)

  for (const candidate of candidates) {
    const value = propertyType(candidate.entity).split('/').at(-1) === 'line_item'
      ? nestedLineItemAmount(candidate.entity)
      : entityMoney(candidate.entity, true)
    if (value.amount !== null) return value
  }
  return { amount: null, currency: null }
}

type EntityShape = {
  type: string
  depth: number
  hasMoneyValue: boolean
  hasNormalizedText: boolean
  mentionTextLength: number
}

function boundedEntityType(entity: DocumentAiEntity) {
  const type = propertyType(entity)
  return /^[a-z0-9_/-]{1,120}$/.test(type) ? type : 'unknown'
}

function entityShape(entity: DocumentAiEntity, depth: number): EntityShape {
  return {
    type: boundedEntityType(entity),
    depth,
    hasMoneyValue: Boolean(entity.normalizedValue?.moneyValue),
    hasNormalizedText: typeof entity.normalizedValue?.text === 'string' && entity.normalizedValue.text.length > 0,
    mentionTextLength: typeof entity.mentionText === 'string' ? Math.min(entity.mentionText.length, 10_000) : 0,
  }
}

/**
 * Safe shape-only metadata for diagnosing parser schema drift in production.
 * It intentionally omits all OCR text, monetary values, image data, IDs,
 * credentials, and document text anchors.
 */
export function documentAiExpenseShape(document: { entities?: unknown }) {
  const entities = Array.isArray(document.entities)
    ? document.entities.filter((entity): entity is DocumentAiEntity => Boolean(entity && typeof entity === 'object'))
    : []
  const lineItems = entities.filter((entity) => propertyType(entity) === 'line_item').slice(0, 20)
  return {
    entityCount: entities.length,
    lineItemCount: lineItems.length,
    lineItems: lineItems.map((lineItem) => ({
      propertyCount: nestedProperties(lineItem).length,
      properties: nestedProperties(lineItem).slice(0, 40).map((property) => entityShape(property.entity, property.depth)),
    })),
  }
}

export function mapExpenseDocument(document: { entities?: unknown }): ReceiptExtraction {
  const entities = Array.isArray(document.entities) ? document.entities.filter((entity): entity is DocumentAiEntity => Boolean(entity && typeof entity === 'object')) : []
  const total = entityMoney(firstEntity(entities, 'total_amount'))
  const tax = entityMoney(firstEntity(entities, 'total_tax_amount'))
  const currency = entityText(firstEntity(entities, 'currency'))
  // Expense Parser emits `payment_method`. The two aliases keep existing
  // drafts usable when a processor version uses a different payment label.
  // This is OCR data only; unknown values deliberately remain unset.
  const paymentMethod = entityText(firstEntityOfTypes(entities, ['payment_method', 'payment_type', 'tender_type']))
  const items = entities.filter((entity) => entity.type === 'line_item').flatMap((entity) => {
    const name = entityText(firstNestedPropertyBySuffix(entity, 'description'))
    if (!name) return []
    return [{ name, quantity: null, amount: lineItemAmount(entity).amount }]
  })
  return receiptSchema.parse({
    merchant: entityText(firstEntity(entities, 'supplier_name')),
    purchasedAt: entityDate(firstEntity(entities, 'receipt_date')),
    total: total.amount,
    tax: tax.amount,
    currency: total.currency ?? (currency && /^[A-Z]{3}$/.test(currency) ? currency : null),
    paymentMethod,
    items,
  })
}

export type DocumentAiEndpointKind = 'regional' | 'global'

/**
 * Document AI accepts regional processor resource names on the regional API
 * hostname. The global hostname is retained only as a US transport fallback:
 * EU requests must never leave their configured regional endpoint.
 */
export function documentAiProcessEndpoint(config: DocumentAiConfig, processorVersion?: string, endpointKind: DocumentAiEndpointKind = 'regional') {
  const processorPath = processorVersion ? `processors/${config.processorId}/processorVersions/${processorVersion}` : `processors/${config.processorId}`
  const hostname = endpointKind === 'global' ? 'documentai.googleapis.com' : `${config.location}-documentai.googleapis.com`
  return `https://${hostname}/v1/projects/${config.projectId}/locations/${config.location}/${processorPath}:process`
}

async function processReceiptWithDocumentAi(input: {
  endpoint: string
  accessToken: string
  bytes: Uint8Array
  mimeType: string
  fetchImpl: FetchLike
  signal: AbortSignal
}) {
  let response: Response
  // workerd's global fetch is a receiver-sensitive host function. Calling it
  // as input.fetchImpl(...) binds `this` to `input`, which can throw
  // "Illegal invocation" before a request reaches Document AI.
  const fetchImpl = input.fetchImpl
  try {
    response = await fetchImpl(input.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ rawDocument: { content: toBase64(input.bytes), mimeType: input.mimeType }, skipHumanReview: true }),
      signal: input.signal,
    })
  } catch (error) {
    throw documentAiTransportError(error, input.signal, 'processing')
  }
  if (!response.ok) throw await documentAiErrorFromResponse(response)

  let result: { document?: unknown }
  try {
    result = await response.json() as { document?: unknown }
  } catch {
    throw new DocumentAiRequestError('読み取りサービスから有効な結果を受け取れませんでした。時間を置いてから再試行してください。', 'DOCUMENT_AI_INVALID_RESPONSE')
  }
  if (!result.document || typeof result.document !== 'object') throw new DocumentAiRequestError('読み取りサービスから有効な結果を受け取れませんでした。時間を置いてから再試行してください。', 'DOCUMENT_AI_INVALID_RESPONSE')
  const document = result.document as { entities?: unknown }
  const extraction = mapExpenseDocument(document)
  if (extraction.items.some((item) => item.amount === null)) {
    // Keep enough structure to diagnose processor-version/schema drift without
    // putting receipt text, amounts, images, document anchors, or credentials
    // into Cloudflare logs.
    console.warn('Receipt OCR line-item amount missing', documentAiExpenseShape(document))
  }
  return extraction
}

async function processWithEndpointFallback(input: {
  config: DocumentAiConfig
  processorVersion?: string
  accessToken: string
  bytes: Uint8Array
  mimeType: string
  fetchImpl: FetchLike
  signal: AbortSignal
}) {
  try {
    return await processReceiptWithDocumentAi({
      endpoint: documentAiProcessEndpoint(input.config, input.processorVersion),
      accessToken: input.accessToken,
      bytes: input.bytes,
      mimeType: input.mimeType,
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    })
  } catch (error) {
    // Google documents both the regional and global hostnames. A rejected
    // regional fetch (no HTTP response) can be Cloudflare's route/DNS/TLS
    // path rather than a processor error. Use the global hostname once for US
    // only; EU must keep its data on the EU regional route.
    if (input.config.location === 'us' && error instanceof DocumentAiRequestError && error.code === 'DOCUMENT_AI_ENDPOINT_UNAVAILABLE' && error.stage === 'processing') {
      return processReceiptWithDocumentAi({
        endpoint: documentAiProcessEndpoint(input.config, input.processorVersion, 'global'),
        accessToken: input.accessToken,
        bytes: input.bytes,
        mimeType: input.mimeType,
        fetchImpl: input.fetchImpl,
        signal: input.signal,
      })
    }
    throw error
  }
}

export async function extractReceiptWithDocumentAi(file: File, config: DocumentAiConfig, fetchImpl: FetchLike = fetch, now = Date.now(), signal = AbortSignal.timeout(20_000)): Promise<ReceiptExtraction> {
  if (!supportedImageTypes.has(file.type)) throw new OcrInputError('PNG、JPEG、WebP の画像を選択してください。')
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new OcrInputError('画像は 1 バイト以上 8 MB 以下にしてください。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!hasValidSignature(file.type, bytes)) throw new OcrInputError('画像形式を確認できませんでした。')

  const accessToken = await getServiceAccountAccessToken(config, fetchImpl, now, signal)
  try {
    return await processWithEndpointFallback({ config, processorVersion: config.processorVersion, accessToken, bytes, mimeType: file.type, fetchImpl, signal })
  } catch (error) {
    // A configured processor version can be deleted or retired. In that one
    // case the processor's default endpoint is the supported safe fallback.
    if (config.processorVersion && error instanceof DocumentAiRequestError && error.httpStatus === 404 && error.googleStatus === 'NOT_FOUND') {
      return processWithEndpointFallback({ config, accessToken, bytes, mimeType: file.type, fetchImpl, signal })
    }
    throw error
  }
}
