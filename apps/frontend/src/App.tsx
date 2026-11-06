import { useCallback, useEffect, useRef, useState } from 'react'
import { RobotFace, type Expression } from './components/RobotFace'
import { useCamera } from './hooks/useCamera'

const VOICE_FILES = [
  '/audio/voice-1.wav',
  '/audio/voice-2.wav',
  '/audio/voice-3.wav',
  '/audio/voice-4.wav',
  '/audio/voice-5.wav',
]

interface WakeLockSentinelLike extends EventTarget {
  released: boolean
  release(): Promise<void>
}

export default function App() {
  const [expression, setExpression] = useState<Expression>('happy')
  const [glitchKey, setGlitchKey] = useState(0)
  const [glitching, setGlitching] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement))
  const secretTapRef = useRef({ count: 0, lastTap: 0 })
  const audioPlayersRef = useRef<HTMLAudioElement[]>([])
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  const lastAudioIndexRef = useRef(-1)
  const glitchTimerRef = useRef<number | null>(null)
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null)
  const { videoRef, status, startCamera, stopCamera, captureFrame } = useCamera()

  const requestWakeLock = useCallback(async () => {
    if (document.visibilityState !== 'visible' || wakeLockRef.current) return
    const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock
    if (!wakeLock) return
    try {
      const sentinel = await wakeLock.request('screen')
      wakeLockRef.current = sentinel
      sentinel.addEventListener('release', () => { wakeLockRef.current = null }, { once: true })
    } catch {
      // Wake Lock is optional and can be rejected by iOS or battery settings.
    }
  }, [])

  const handleTouch = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const inSecretCorner = event.clientX <= window.innerWidth * 0.16 && event.clientY <= window.innerHeight * 0.22
    if (inSecretCorner) {
      const now = performance.now()
      const nextCount = now - secretTapRef.current.lastTap < 700 ? secretTapRef.current.count + 1 : 1
      secretTapRef.current = { count: nextCount, lastTap: now }
      if (nextCount >= 3) {
        secretTapRef.current = { count: 0, lastTap: 0 }
        setAdminOpen(true)
        void startCamera()
      }
      return
    }

    secretTapRef.current = { count: 0, lastTap: 0 }
    setExpression('hurt')
    setGlitchKey((current) => current + 1)
    setGlitching(true)
    if (glitchTimerRef.current) window.clearTimeout(glitchTimerRef.current)
    glitchTimerRef.current = window.setTimeout(() => setGlitching(false), 620)
    if (audioPlayersRef.current.length) {
      let nextIndex = Math.floor(Math.random() * audioPlayersRef.current.length)
      if (audioPlayersRef.current.length > 1 && nextIndex === lastAudioIndexRef.current) {
        nextIndex = (nextIndex + 1 + Math.floor(Math.random() * (audioPlayersRef.current.length - 1))) % audioPlayersRef.current.length
      }
      currentAudioRef.current?.pause()
      if (currentAudioRef.current) currentAudioRef.current.currentTime = 0
      const player = audioPlayersRef.current[nextIndex]
      player.currentTime = 0
      player.onended = () => setExpression('happy')
      player.onerror = () => setExpression('happy')
      currentAudioRef.current = player
      lastAudioIndexRef.current = nextIndex
      void player.play().catch(() => setExpression('happy'))
    } else setExpression('happy')
    void startCamera()
    void requestWakeLock()
  }, [requestWakeLock, startCamera])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      // iPhone Safari may only provide fullscreen through an installed PWA.
    }
  }, [])

  const restartCamera = useCallback(async () => {
    stopCamera()
    await startCamera()
  }, [startCamera, stopCamera])

  useEffect(() => {
    audioPlayersRef.current = VOICE_FILES.map((source) => {
      const audio = new Audio(source)
      audio.preload = 'auto'
      return audio
    })
    return () => {
      if (glitchTimerRef.current) window.clearTimeout(glitchTimerRef.current)
      audioPlayersRef.current.forEach((audio) => {
        audio.pause()
        audio.src = ''
      })
      audioPlayersRef.current = []
    }
  }, [])

  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'visible') void requestWakeLock()
    }
    document.addEventListener('visibilitychange', resume)
    return () => document.removeEventListener('visibilitychange', resume)
  }, [requestWakeLock])

  useEffect(() => {
    const updateFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', updateFullscreen)
    return () => document.removeEventListener('fullscreenchange', updateFullscreen)
  }, [])

  // Expose frame capture for a future AI integration without adding server traffic.
  useEffect(() => {
    window.captureFrame = captureFrame
    return () => { delete window.captureFrame }
  }, [captureFrame])

  return (
    <main className="app" onPointerUp={handleTouch}>
      <div
        className={`face-stage${glitching ? ' is-glitching' : ''}`}
        style={glitching ? { animationName: glitchKey % 2 ? 'glitch-hit-a' : 'glitch-hit-b' } : undefined}
      >
        <RobotFace expression={expression} />
      </div>
      {glitching && <div key={glitchKey} className="glitch-overlay" aria-hidden="true" />}
      <video ref={videoRef} className={`camera-video${adminOpen ? ' camera-preview' : ''}`} playsInline muted autoPlay />
      {import.meta.env.DEV && <div className={`camera-status status-${status}`}>camera: {status}</div>}
      {adminOpen && (
        <section className="admin-panel" onPointerUp={(event) => event.stopPropagation()} aria-label="관리자 패널">
          <header className="admin-header">
            <div>
              <p className="admin-kicker">ROBOT FACE</p>
              <h1>관리자 패널</h1>
            </div>
            <button className="icon-button" type="button" onClick={() => setAdminOpen(false)} aria-label="관리자 패널 닫기">×</button>
          </header>

          <div className="admin-camera-card">
            <div className="camera-frame" aria-hidden="true" />
            <div className="camera-meta">
              <span className={`status-dot status-${status}`} />
              <span>전면 카메라</span>
              <strong>{status === 'active' ? '정상 작동 중' : status}</strong>
            </div>
          </div>

          <div className="admin-actions">
            <button type="button" onClick={toggleFullscreen}>
              <span className="action-icon">{isFullscreen ? '↙' : '↗'}</span>
              <span>{isFullscreen ? '전체화면 종료' : '전체화면 시작'}</span>
            </button>
            <button type="button" onClick={restartCamera}>
              <span className="action-icon">↻</span>
              <span>카메라 재시작</span>
            </button>
          </div>

          <p className="admin-note">iPhone Safari에서는 홈 화면에 추가한 앱으로 실행하면 가장 넓은 화면을 사용할 수 있습니다.</p>
        </section>
      )}
    </main>
  )
}

declare global {
  interface Window {
    captureFrame?: () => Promise<Blob | null>
  }
}
