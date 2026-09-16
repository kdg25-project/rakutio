import { describe, expect, it } from 'vitest'

import { OcrInputError } from '../../ocr/receipt'
import { validateReceiptUploads } from './upload'

const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' })

describe('receipt page upload validation', () => {
  it('accepts ordered PNG pages and caps the submission at six pages', async () => {
    await expect(validateReceiptUploads([png('0.png'), png('1.png')])).resolves.toBeUndefined()
    await expect(validateReceiptUploads(Array.from({ length: 7 }, (_, index) => png(`${index}.png`)))).rejects.toThrow(new OcrInputError('画像は 1〜6 枚選択してください。'))
  })
})
