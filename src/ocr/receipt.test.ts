import { webcrypto } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
  DocumentAiRequestError,
  OcrConfigurationError,
  extractReceiptWithDocumentAi,
  getServiceAccountAccessToken,
  mapExpenseDocument,
  validateDocumentAiConfig,
  type DocumentAiConfig,
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
        { type: 'total_amount', normalizedValue: { moneyValue: { units: '12', nanos: 500000000, currencyCode: 'USD' } } },
        { type: 'line_item', properties: [
          { type: 'line_item/description', mentionText: 'りんご' },
          { type: 'line_item/amount', normalizedValue: { moneyValue: { units: '4', nanos: 250000000, currencyCode: 'USD' } } },
        ] },
      ],
    })).toEqual({ merchant: 'テスト商店', purchasedAt: '2026-09-15', total: 12.5, tax: null, currency: 'USD', items: [{ name: 'りんご', quantity: null, amount: 4.25 }] })

    expect(mapExpenseDocument({ entities: [{ type: 'supplier_name', mentionText: '未確定' }, { type: 'total_amount', mentionText: '合計' }, { type: 'receipt_date', mentionText: '2026-99-99' }] })).toMatchObject({ purchasedAt: null, total: null, currency: null, items: [] })
    expect(mapExpenseDocument({ entities: [{ type: 'receipt_date', mentionText: '2026-02-29' }] }).purchasedAt).toBeNull()
    expect(mapExpenseDocument({ entities: [{ type: 'receipt_date', mentionText: '2024-02-29' }] }).purchasedAt).toBe('2024-02-29')
  })

  it('rejects missing credentials and failed token exchange', async () => {
    expect(() => validateDocumentAiConfig({ projectId: 'receipt-project', location: 'us', processorId: 'processor-123' })).toThrow(OcrConfigurationError)
    await expect(getServiceAccountAccessToken(config(), vi.fn().mockResolvedValue(new Response(null, { status: 401 })))).rejects.toThrow(DocumentAiRequestError)
    await expect(getServiceAccountAccessToken({ ...config(), serviceAccountPrivateKey: '$not-base64$' }, vi.fn())).rejects.toThrow(OcrConfigurationError)
    await expect(getServiceAccountAccessToken({ ...config(), serviceAccountPrivateKey: 'aW52YWxpZC1wa2NzOA==' }, vi.fn())).rejects.toThrow(OcrConfigurationError)
  })

  it('uses one timeout signal for OAuth and Document AI processing', async () => {
    const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'receipt.png', { type: 'image/png' })
    const signal = new AbortController().signal
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ document: { entities: [] } })))
    await expect(extractReceiptWithDocumentAi(png, config(), fetchMock, Date.now(), signal)).resolves.toMatchObject({ total: null })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal)
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(signal)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://us-documentai.googleapis.com/v1/projects/receipt-project/locations/us/processors/processor-123:process')
  })
})
