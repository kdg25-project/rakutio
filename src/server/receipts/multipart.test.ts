import { describe, expect, it } from 'vitest'

import { MAX_MULTIPART_BYTES, readBoundedMultipartFormData } from './multipart'
import { OcrInputError } from '../../ocr/receipt'

function multipartRequest(boundary: string, body: string, headers: HeadersInit = {}) {
  return new Request('http://localhost/api/ocr/receipt', {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      ...headers,
    },
    body,
  })
}

describe('bounded OCR multipart parser', () => {
  it('preserves a mixed-case browser boundary while parsing the uploaded image', async () => {
    const boundary = '----WebKitFormBoundaryAbCdEf123456'
    const formData = await readBoundedMultipartFormData(multipartRequest(boundary, [
      `--${boundary}`,
      'Content-Disposition: form-data; name="image"; filename="receipt.png"',
      'Content-Type: image/png',
      '',
      'png-content',
      `--${boundary}--`,
      '',
    ].join('\r\n')))

    const image = formData.get('image')
    expect(image).toBeInstanceOf(File)
    expect((image as File).name).toBe('receipt.png')
    await expect((image as File).text()).resolves.toBe('png-content')
  })

  it('rejects a declared multipart body larger than the receipt limit', async () => {
    const request = multipartRequest('Boundary', '--Boundary--\r\n', {
      'content-length': String(MAX_MULTIPART_BYTES + 1),
    })

    await expect(readBoundedMultipartFormData(request)).rejects.toThrow(new OcrInputError('画像は合計 48 MB 以下にしてください。'))
  })

  it('reports malformed multipart input without leaking a parser error', async () => {
    const request = multipartRequest('Boundary', 'not-a-valid-multipart-body')

    await expect(readBoundedMultipartFormData(request)).rejects.toThrow(new OcrInputError('送信された画像フォームを読み取れませんでした。'))
  })
})
