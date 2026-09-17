import { ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'

import './receipt-camera.css'

type FacingMode = 'environment' | 'user'
type TorchTrack = MediaStreamTrack & {
  getCapabilities?: () => MediaTrackCapabilities & { torch?: boolean }
  applyConstraints: (constraints: MediaTrackConstraints & { advanced?: Array<{ torch?: boolean }> }) => Promise<void>
}

export type ReceiptCameraProps = {
  onCapture: (file: File) => void | Promise<void>
  onCancel: () => void
  onFallbackFiles: (files: File[]) => void
}

export const receiptFileAccept = 'image/png,image/jpeg,image/webp'

export function receiptCameraConstraints(facingMode: FacingMode): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1440 },
      height: { ideal: 1920 },
    },
  }
}

export function cameraErrorMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'カメラの利用が許可されていません。写真を選択して続けられます。'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '利用できるカメラが見つかりません。写真を選択して続けられます。'
  if (name === 'NotReadableError') return 'カメラを開始できませんでした。他のアプリでカメラを使っていないか確認してください。'
  return 'カメラを利用できません。写真を選択して続けられます。'
}

export function stopCameraStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((track) => track.stop())
}

export async function videoFrameFile(video: HTMLVideoElement, name = `receipt-${Date.now()}.jpg`): Promise<File> {
  const width = video.videoWidth
  const height = video.videoHeight
  if (!width || !height) throw new Error('カメラ映像の準備ができていません。少し待ってから撮影してください。')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('写真を作成できませんでした。')
  context.drawImage(video, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  if (!blob) throw new Error('写真を作成できませんでした。')
  return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() })
}

export function ReceiptCamera({ onCapture, onCancel, onFallbackFiles }: ReceiptCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const mountedRef = useRef(false)
  const sequenceRef = useRef(0)
  const [facingMode, setFacingMode] = useState<FacingMode>('environment')
  const [state, setState] = useState<'starting' | 'ready' | 'fallback'>('starting')
  const [message, setMessage] = useState('カメラを起動しています…')
  const [torchAvailable, setTorchAvailable] = useState(false)
  const [torchEnabled, setTorchEnabled] = useState(false)
  const [cameraCount, setCameraCount] = useState(0)
  const [capturedCount, setCapturedCount] = useState(0)
  const [capturing, setCapturing] = useState(false)

  const stopStream = useCallback(() => {
    const stream = streamRef.current
    streamRef.current = null
    stopCameraStream(stream)
  }, [])

  const startCamera = useCallback(async (nextFacingMode: FacingMode) => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      if (mountedRef.current) { setState('fallback'); setMessage('この端末ではカメラを利用できません。写真を選択してください。') }
      return
    }
    const request = ++sequenceRef.current
    stopStream()
    if (mountedRef.current) { setState('starting'); setMessage('カメラを起動しています…'); setTorchAvailable(false); setTorchEnabled(false) }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(receiptCameraConstraints(nextFacingMode))
      if (!mountedRef.current || request !== sequenceRef.current) { stopCameraStream(stream); return }
      streamRef.current = stream
      const video = videoRef.current
      if (!video) { stopStream(); return }
      video.srcObject = stream
      await video.play().catch(() => undefined)
      const track = stream.getVideoTracks()[0] as TorchTrack | undefined
      const capabilities = track?.getCapabilities?.() as { torch?: boolean } | undefined
      setTorchAvailable(Boolean(capabilities?.torch))
      setState('ready')
      setMessage('レシート全体が枠に入るようにしてください。')
      void navigator.mediaDevices.enumerateDevices?.().then((devices) => {
        if (mountedRef.current && request === sequenceRef.current) setCameraCount(devices.filter((device) => device.kind === 'videoinput').length)
      }).catch(() => undefined)
    } catch (error) {
      if (mountedRef.current && request === sequenceRef.current) { setState('fallback'); setMessage(cameraErrorMessage(error)) }
    }
  }, [stopStream])

  useEffect(() => {
    mountedRef.current = true
    void startCamera(facingMode)
    const visibility = () => {
      if (document.visibilityState === 'hidden') { stopStream(); return }
      if (!streamRef.current) void startCamera(facingMode)
    }
    window.addEventListener('pagehide', stopStream)
    document.addEventListener('visibilitychange', visibility)
    return () => { mountedRef.current = false; ++sequenceRef.current; window.removeEventListener('pagehide', stopStream); document.removeEventListener('visibilitychange', visibility); stopStream() }
  }, [facingMode, startCamera, stopStream])

  async function capture() {
    const video = videoRef.current
    if (!video || capturing) return
    setCapturing(true)
    try {
      const file = await videoFrameFile(video, `receipt-${Date.now()}-${capturedCount + 1}.jpg`)
      await onCapture(file)
      if (mountedRef.current) { setCapturedCount((count) => count + 1); setMessage('撮影しました。続けて撮影できます。') }
    } catch (error) {
      if (mountedRef.current) setMessage(error instanceof Error ? error.message : '写真を作成できませんでした。')
    } finally { if (mountedRef.current) setCapturing(false) }
  }

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length) onFallbackFiles(files)
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0] as TorchTrack | undefined
    if (!track?.applyConstraints) return
    const next = !torchEnabled
    try { await track.applyConstraints({ advanced: [{ torch: next }] }); setTorchEnabled(next) } catch { setMessage('フラッシュを切り替えられませんでした。') }
  }

  const fallback = state === 'fallback'
  return <section className="receipt-camera-live" aria-label="レシートを撮影">
    <div className="receipt-camera-live__preview" data-state={state}>
      {fallback ? <div className="receipt-camera-live__fallback"><img src="/icons/category-other.svg" alt="" /><b>写真を選択</b><span>カメラを使えない場合も、保存済みの画像を選べます。</span></div> : <video ref={videoRef} autoPlay muted playsInline aria-label="レシート撮影プレビュー" />}
      {!fallback && <><i className="receipt-camera-live__corner top-left" /><i className="receipt-camera-live__corner top-right" /><i className="receipt-camera-live__corner bottom-left" /><i className="receipt-camera-live__corner bottom-right" /></>}
    </div>
    <p className={`receipt-camera-live__message${fallback ? '' : ' visually-hidden'}`} role="status">{message}</p>
    <div className="receipt-camera-live__controls">
      <label className="receipt-camera-live__utility"><span className="receipt-camera-live__library-icon" aria-hidden="true" /><span>写真を選択</span><input type="file" accept={receiptFileAccept} multiple onChange={chooseFiles} /></label>
      {!fallback && <button className="receipt-camera-live__shutter" type="button" onClick={() => void capture()} disabled={state !== 'ready' || capturing} aria-label="撮影する"><span /></button>}
      {fallback ? <button type="button" className="receipt-camera-live__retry" onClick={() => void startCamera(facingMode)}>カメラを再試行</button> : <button className="receipt-camera-live__utility" type="button" onClick={() => void toggleTorch()} disabled={!torchAvailable} aria-label={torchEnabled ? 'フラッシュをオフにする' : 'フラッシュをオンにする'}><span className="receipt-camera-live__flash-icon" aria-hidden="true">ϟ</span><span>{torchEnabled ? 'オン' : 'オフ'}</span></button>}
    </div>
    {!fallback && <div className="receipt-camera-live__tools visually-hidden"><span>{capturedCount ? `${capturedCount}枚撮影済み` : '続けて複数枚撮影できます'}</span>{cameraCount >= 2 && <button type="button" onClick={() => { const next = facingMode === 'environment' ? 'user' : 'environment'; setFacingMode(next) }}>カメラを切替</button>}</div>}
    <button className="receipt-camera-live__cancel" type="button" onClick={onCancel}>キャンセル</button>
  </section>
}
