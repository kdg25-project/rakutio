import { describe, expect, it, vi } from 'vitest'

import { cameraErrorMessage, receiptCameraConstraints, receiptFileAccept, stopCameraStream, videoFrameFile } from './receipt-camera'

describe('receipt camera helpers', () => {
  it('requests the rear camera with audio disabled', () => {
    expect(receiptCameraConstraints('environment')).toEqual({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1440 }, height: { ideal: 1920 } } })
    expect(receiptCameraConstraints('user').video).toMatchObject({ facingMode: { ideal: 'user' } })
  })

  it('has a multi-image fallback restricted to OCR-supported types', () => {
    expect(receiptFileAccept).toBe('image/png,image/jpeg,image/webp')
    expect(cameraErrorMessage(new DOMException('denied', 'NotAllowedError'))).toContain('許可')
    expect(cameraErrorMessage(new DOMException('none', 'NotFoundError'))).toContain('見つかりません')
  })

  it('keeps the fallback picker in the photo library instead of opening a second native camera sheet', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./receipt-camera.tsx', import.meta.url), 'utf8'))
    const styles = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./receipt-camera.css', import.meta.url), 'utf8'))
    expect(source).toContain('<span>写真を選択</span><input type="file" accept={receiptFileAccept} multiple')
    expect(source).toContain('フラッシュをオンにする')
    expect(source).toContain('<svg className="receipt-camera-live__utility-icon" viewBox="0 0 24 24" aria-hidden="true">')
    expect(source).toContain('<rect x="3.5" y="4" width="17" height="16" rx="3" />')
    expect(source).toContain('<path d="M3 21 21 3" />')
    expect(styles).toContain('.receipt-camera-live__utility-icon { display: block; fill: none;')
    expect(styles).not.toContain('receipt-camera-live__library-icon')
    expect(styles).not.toContain('receipt-camera-live__flash-icon')
    expect(source).not.toContain('capture="environment"')
  })

  it('stops every media track on cancellation and page cleanup', () => {
    const first = { stop: vi.fn() } as unknown as MediaStreamTrack
    const second = { stop: vi.fn() } as unknown as MediaStreamTrack
    stopCameraStream({ getTracks: () => [first, second] } as unknown as MediaStream)
    expect(first.stop).toHaveBeenCalledOnce(); expect(second.stop).toHaveBeenCalledOnce()
  })

  it('captures independent JPEG files for sequential photos', async () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toBlob: (callback: BlobCallback) => callback(new Blob(['photo'], { type: 'image/jpeg' })) }
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })
    const video = { videoWidth: 120, videoHeight: 180 } as HTMLVideoElement
    const first = await videoFrameFile(video, 'first.jpg'); const second = await videoFrameFile(video, 'second.jpg')
    expect([first.name, second.name]).toEqual(['first.jpg', 'second.jpg']); expect(first.type).toBe('image/jpeg'); expect(canvas.width).toBe(120); expect(canvas.height).toBe(180)
    vi.unstubAllGlobals()
  })
})
