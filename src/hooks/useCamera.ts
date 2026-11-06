import { useCallback, useEffect, useRef, useState } from 'react'

export type CameraStatus = 'idle' | 'requesting' | 'active' | 'denied' | 'unavailable' | 'error'

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [status, setStatus] = useState<CameraStatus>('idle')
  const requestInFlight = useRef<Promise<boolean> | null>(null)

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const startCamera = useCallback(async (): Promise<boolean> => {
    if (streamRef.current?.getVideoTracks().some((track) => track.readyState === 'live')) return true
    if (requestInFlight.current) return requestInFlight.current

    const request = (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('unavailable')
        return false
      }

      setStatus('requesting')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play()
        }
        setStatus('active')
        return true
      } catch (error) {
        const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
        setStatus(denied ? 'denied' : 'error')
        return false
      } finally {
        requestInFlight.current = null
      }
    })()

    requestInFlight.current = request
    return request
  }, [])

  const captureFrame = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return null

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(video, 0, 0, canvas.width, canvas.height)

    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
  }, [])

  useEffect(() => stopCamera, [stopCamera])

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible' || !streamRef.current) return
      const live = streamRef.current.getVideoTracks().some((track) => track.readyState === 'live')
      if (!live) void startCamera()
      else void videoRef.current?.play().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [startCamera])

  return { videoRef, status, startCamera, stopCamera, captureFrame }
}
