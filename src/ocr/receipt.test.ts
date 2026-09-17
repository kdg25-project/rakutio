import { webcrypto } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
  DocumentAiRequestError,
  OcrConfigurationError,
  documentAiExpenseShape,
  documentAiProcessEndpoint,
  extractReceiptWithDocumentAi,
  getServiceAccountAccessToken,
  mapExpenseDocument,
  validateDocumentAiConfig,
  type DocumentAiConfig,
  type FetchLike,
} from './receipt'

let privateKeyPem = ''

beforeAll(async () => {
  vi.stubGlobal('crypto', webcrypto)
  const keyPair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----`
})

function config(): DocumentAiConfig {
  return {
    projectId: 'receipt-project',
    location: 'us',
    processorId: 'processor-123',
    serviceAccountEmail: 'receipt-worker@receipt-project.iam.gserviceaccount.com',
    serviceAccountPrivateKey: privateKeyPem,
  }
}

function png() {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'receipt.png', { type: 'image/png' })
}

describe('Document AI receipt adapter', () => {
  it('signs a service-account assertion and exchanges it only with Google OAuth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'access-token' })))
    await expect(getServiceAccountAccessToken(config(), fetchMock, 1_700_000_000_000)).resolves.toBe('access-token')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://oauth2.googleapis.com/token')
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(body.get('assertion')).toMatch(/^ey.+\..+\..+/)
  })

  it('maps normalized expense entities without fabricating unknown totals or currencies', () => {
    expect(mapExpenseDocument({
      entities: [
        { type: 'supplier_name', mentionText: 'テスト商店' },
        { type: 'receipt_date', normalizedValue: { dateValue: { year: 2026, month: 9, day: 15 } } },
        { type: 'payment_method', normalizedValue: { text: 'クレジットカード' } },
        { type: 'total_amount', normalizedValue: { moneyValue: { units: '12', nanos: 500000000, currencyCode: 'USD' } } },
        { type: 'line_item', properties: [
          { type: 'line_item/description', mentionText: 'りんご' },
          { type: 'line_item/amount', normalizedValue: { moneyValue: { units: '4', nanos: 250000000, currencyCode: 'USD' } } },
        ] },
      ],
    })).toEqual({ merchant: 'テスト商店', purchasedAt: '2026-09-15', total: 12.5, tax: null, currency: 'USD', paymentMethod: 'クレジットカード', items: [{ name: 'りんご', quantity: null, amount: 4.25 }] })

    expect(mapExpenseDocument({ entities: [{ type: 'supplier_name', mentionText: '未確定' }, { type: 'total_amount', mentionText: '合計' }, { type: 'receipt_date', mentionText: '2026-99-99' }] })).toMatchObject({ purchasedAt: null, total: null, currency: null, items: [] })
    expect(mapExpenseDocument({ entities: [{ type: 'receipt_date', mentionText: '2026-02-29' }] }).purchasedAt).toBeNull()
    expect(mapExpenseDocument({ entities: [{ type: 'receipt_date', mentionText: '2024-02-29' }] }).purchasedAt).toBe('2024-02-29')
  })

  it('keeps the payment method unset unless the Expense Parser provides a supported payment entity', () => {
    expect(mapExpenseDocument({ entities: [{ type: 'payment_method', mentionText: '現金' }] }).paymentMethod).toBe('現金')
    expect(mapExpenseDocument({ entities: [{ type: 'payment_type', normalizedValue: { text: '電子マネー' } }] }).paymentMethod).toBe('電子マネー')
    expect(mapExpenseDocument({ entities: [{ type: 'unrelated_payment', mentionText: 'カード' }] }).paymentMethod).toBeNull()
  })

  it('maps line-item amounts returned as receipt text when moneyValue is absent', () => {
    expect(mapExpenseDocument({
      entities: [{ type: 'line_item', properties: [
        { type: 'line_item/description', mentionText: 'パンフレット' },
        { type: 'line_item/amount', mentionText: '￥１，１００' },
      ] }],
    }).items).toEqual([{ name: 'パンフレット', quantity: null, amount: 1100 }])

    expect(mapExpenseDocument({
      entities: [{ type: 'line_item', properties: [
        { type: 'line_item/description', mentionText: 'ドリンク' },
        { type: 'line_item/amount', normalizedValue: { text: '600' } },
      ] }],
    }).items[0]?.amount).toBe(600)
  })

  it('maps nested Expense Parser line-item amount and price properties without using receipt totals', () => {
    const receipt = mapExpenseDocument({
      entities: [
        { type: 'total_amount', normalizedValue: { moneyValue: { units: '2910', nanos: 0, currencyCode: 'JPY' } } },
        { type: 'line_item', properties: [
          { type: 'line_item/description', mentionText: 'パンフ オデュッセイア' },
          { type: 'line_item/details', properties: [
            { type: 'line_item/details/amount', normalizedValue: { moneyValue: { units: '1100', nanos: 0, currencyCode: 'JPY' } } },
          ] },
        ] },
        { type: 'line_item', properties: [
          { type: 'line_item/description', mentionText: 'キーホルダー' },
          { type: 'line_item/pricing', properties: [
            { type: 'line_item/pricing/price', mentionText: '1 x ￥1,210' },
            { type: 'line_item/pricing/tax_amount', mentionText: '110' },
          ] },
        ] },
        { type: 'line_item', properties: [
          { type: 'line_item/description', mentionText: 'メタリックCF' },
          { type: 'line_item/amount', properties: [
            { type: 'line_item/amount/amount', normalizedValue: { moneyValue: { units: '600', nanos: 0, currencyCode: 'JPY' } } },
          ] },
        ] },
      ],
    })

    expect(receipt.total).toBe(2910)
    expect(receipt.items).toEqual([
      { name: 'パンフ オデュッセイア', quantity: null, amount: 1100 },
      { name: 'キーホルダー', quantity: null, amount: 1210 },
      { name: 'メタリックCF', quantity: null, amount: 600 },
    ])
  })

  it('uses an amount-shaped nested line_item only after explicit amount properties are absent', () => {
    const receipt = mapExpenseDocument({
      entities: [
        { type: 'line_item', properties: [
          { type: 'line_item/description', mentionText: 'パンフレット' },
          { type: 'line_item', mentionText: '(1 1,100 1,100)' },
        ] },
        { type: 'line_item', properties: [
          { type: 'line_item/description', mentionText: '飲料 500ml' },
          { type: 'line_item', mentionText: '飲料 500ml' },
        ] },
      ],
    })

    expect(receipt.items).toEqual([
      { name: 'パンフレット', quantity: null, amount: 1100 },
      { name: '飲料 500ml', quantity: null, amount: null },
    ])
  })

  it('creates only shape metadata for unresolved line-item amounts', () => {
    const shape = documentAiExpenseShape({
      entities: [{ type: 'line_item', properties: [
        { type: 'line_item/description', mentionText: 'private product text' },
        { type: 'line_item/amount', normalizedValue: { text: '1234' }, mentionText: '￥1,234' },
      ] }],
    })

    expect(shape).toEqual({
      entityCount: 1,
      lineItemCount: 1,
      lineItems: [{
        propertyCount: 2,
        properties: [
          { type: 'line_item/description', depth: 1, hasMoneyValue: false, hasNormalizedText: false, mentionTextLength: 20 },
          { type: 'line_item/amount', depth: 1, hasMoneyValue: false, hasNormalizedText: true, mentionTextLength: 6 },
        ],
      }],
    })
    expect(JSON.stringify(shape)).not.toContain('private product text')
    expect(JSON.stringify(shape)).not.toContain('1234')
  })

  it('does not treat an arbitrary number in a total mention as the total', () => {
    expect(mapExpenseDocument({
      entities: [{ type: 'total_amount', mentionText: '3点 ￥2,910' }],
    }).total).toBeNull()
  })

  it('rejects missing credentials and failed token exchange', async () => {
    expect(() => validateDocumentAiConfig({ projectId: 'receipt-project', location: 'us', processorId: 'processor-123' })).toThrow(OcrConfigurationError)
    await expect(getServiceAccountAccessToken(config(), vi.fn().mockResolvedValue(new Response(null, { status: 401 })))).rejects.toThrow(DocumentAiRequestError)
    await expect(getServiceAccountAccessToken({ ...config(), serviceAccountPrivateKey: '$not-base64$' }, vi.fn())).rejects.toThrow(OcrConfigurationError)
    await expect(getServiceAccountAccessToken({ ...config(), serviceAccountPrivateKey: 'aW52YWxpZC1wa2NzOA==' }, vi.fn())).rejects.toThrow(OcrConfigurationError)
  })

  it('classifies an OAuth transport failure without exposing the token endpoint', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('getaddrinfo ENOTFOUND oauth2.googleapis.com'))

    await expect(getServiceAccountAccessToken(config(), fetchMock)).rejects.toMatchObject({
      code: 'DOCUMENT_AI_AUTH_NETWORK_ERROR',
      message: expect.not.stringContaining('oauth2.googleapis.com'),
    })
  })

  it('uses one timeout signal for OAuth and Document AI processing', async () => {
    const signal = new AbortController().signal
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: { entities: [] } })))
    await expect(extractReceiptWithDocumentAi(png(), config(), fetchMock, Date.now(), signal)).resolves.toMatchObject({ total: null })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal)
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(signal)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://us-documentai.googleapis.com/v1/projects/receipt-project/locations/us/processors/processor-123:process')
  })

  it('calls the Document AI fetch implementation without binding it to request state', async () => {
    const calls: string[] = []
    const receiverSensitiveFetch = (async function (this: unknown, input: RequestInfo | URL) {
      if (this !== undefined) throw new TypeError('Illegal invocation')
      calls.push(String(input))
      if (String(input) === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'access-token' }))
      return new Response(JSON.stringify({ document: { entities: [] } }))
    }) as FetchLike

    await expect(extractReceiptWithDocumentAi(png(), config(), receiverSensitiveFetch)).resolves.toMatchObject({ total: null })
    expect(calls).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://us-documentai.googleapis.com/v1/projects/receipt-project/locations/us/processors/processor-123:process',
    ])
  })

  it('builds the documented regional and US global-fallback processor endpoints', () => {
    expect(documentAiProcessEndpoint(config())).toBe('https://us-documentai.googleapis.com/v1/projects/receipt-project/locations/us/processors/processor-123:process')
    expect(documentAiProcessEndpoint(config(), 'version-123')).toBe('https://us-documentai.googleapis.com/v1/projects/receipt-project/locations/us/processors/processor-123/processorVersions/version-123:process')
    expect(documentAiProcessEndpoint(config(), undefined, 'global')).toBe('https://documentai.googleapis.com/v1/projects/receipt-project/locations/us/processors/processor-123:process')
  })

  it('falls back once from a rejected US regional endpoint to the global hostname', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token' })))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: { entities: [] } })))

    await expect(extractReceiptWithDocumentAi(png(), config(), fetchMock)).resolves.toMatchObject({ total: null })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://us-documentai.googleapis.com/v1/projects/receipt-project/locations/us/processors/processor-123:process')
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://documentai.googleapis.com/v1/projects/receipt-project/locations/us/processors/processor-123:process')
  })

  it('does not use the global hostname after a rejected EU regional endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token' })))
      .mockRejectedValueOnce(new TypeError('fetch failed'))

    await expect(extractReceiptWithDocumentAi(png(), { ...config(), location: 'eu' }, fetchMock)).rejects.toMatchObject({
      code: 'DOCUMENT_AI_ENDPOINT_UNAVAILABLE',
      stage: 'processing',
      transportErrorName: 'TypeError',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('distinguishes a Document AI endpoint transport failure without exposing endpoint details', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token' })))
      .mockRejectedValueOnce(new TypeError('getaddrinfo ENOTFOUND us-documentai.googleapis.com for receipt-project'))
      .mockRejectedValueOnce(new TypeError('getaddrinfo ENOTFOUND documentai.googleapis.com for receipt-project'))

    await expect(extractReceiptWithDocumentAi(png(), config(), fetchMock)).rejects.toMatchObject({
      code: 'DOCUMENT_AI_ENDPOINT_UNAVAILABLE',
      stage: 'processing',
      transportErrorName: 'TypeError',
      message: expect.not.stringContaining('us-documentai.googleapis.com'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries a missing configured processor version once through the default processor endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'processor version was removed' } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: { entities: [] } })))

    await expect(extractReceiptWithDocumentAi(png(), { ...config(), processorVersion: 'version-123' }, fetchMock)).resolves.toMatchObject({ total: null })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://us-documentai.googleapis.com/v1/projects/receipt-project/locations/us/processors/processor-123/processorVersions/version-123:process')
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://us-documentai.googleapis.com/v1/projects/receipt-project/locations/us/processors/processor-123:process')
  })

  it('classifies the default processor failure after a version fallback without leaking provider details', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'version no longer exists' } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'projects/secret-project/processors/secret-processor' } }), { status: 404 }))

    await expect(extractReceiptWithDocumentAi(png(), { ...config(), processorVersion: 'version-123' }, fetchMock)).rejects.toMatchObject({
      code: 'DOCUMENT_AI_PROCESSOR_NOT_FOUND',
      httpStatus: 404,
      googleStatus: 'NOT_FOUND',
      message: expect.not.stringContaining('secret-processor'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('classifies permission failures and does not fall back to another endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'caller has no permission' } }), { status: 403 }))

    await expect(extractReceiptWithDocumentAi(png(), { ...config(), processorVersion: 'version-123' }, fetchMock)).rejects.toMatchObject({
      code: 'DOCUMENT_AI_PERMISSION_DENIED',
      httpStatus: 403,
      googleStatus: 'PERMISSION_DENIED',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses a safe classified error when the provider sends a malformed error body', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token' })))
      .mockResolvedValueOnce(new Response('not-json: token=should-not-be-exposed', { status: 400 }))

    await expect(extractReceiptWithDocumentAi(png(), config(), fetchMock)).rejects.toMatchObject({
      code: 'DOCUMENT_AI_INVALID_ARGUMENT',
      httpStatus: 400,
      googleStatus: null,
      message: expect.not.stringContaining('should-not-be-exposed'),
    })
  })
})
