import { useCallback, useEffect, useRef, useState } from 'react'
import { RobotFace, type Expression } from './components/RobotFace'
import { useCamera } from './hooks/useCamera'
import { AUTO_CAPTURE, OBSERVATION_TOKEN, OBSERVATION_URL, VISIT } from './config'
import { usePersonDetector } from './hooks/usePersonDetector'
import { sendObservation, sendTranscript } from './observation'
import { startListening, type SpeechSession } from './speech'
import {
  isArticleGenerating,
  isInstagramPublishing,
  isPublicationProblem,
  isPublished,
  publicationStage,
  waitForAnyPublication,
  type PublicationConnection,
  type PublicationStatus,
} from './publication'

type CaptureState = { kind: 'idle' | 'busy' | 'ok' | 'error'; message: string }
type VisitState = { phase: 'idle' | 'running' | 'processing'; photos: number; until: number; eventId?: string }
type PiezoReading = { level: number; stage: 1 | 2; strength: 'weak' | 'strong' }
type PiezoDisplay = PiezoReading | { level: number; reaction: 'surprised' }
type BubblePlacement = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right'

const BUBBLE_PLACEMENTS: BubblePlacement[] = ['top-left', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

type HurtStage = 1 | 2
type RobotStatus = {
  driving: boolean; online: boolean; synced?: boolean; updatedAt: string; lastSeenAt: string | null
  reported?: 'driving' | 'paused' | null; changedBy?: string; seenMsAgo?: number | null
}

function agoText(ms: number) {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}초 전`
  const min = Math.round(sec / 60)
  return min < 60 ? `${min}분 전` : `${Math.round(min / 60)}시간 전`
}
type HurtVoice = { source: string; text: string; stage: HurtStage }

const HURT_VOICES: HurtVoice[] = [
  { source: '/audio/hurt-1-1.wav', text: '아파요', stage: 1 },
  { source: '/audio/hurt-1-2.wav', text: '아야!', stage: 1 },
  { source: '/audio/hurt-1-3.wav', text: '엄마야!', stage: 1 },
  { source: '/audio/hurt-1-4.wav', text: '꺄!', stage: 1 },
  { source: '/audio/hurt-2-1.wav', text: '아이씨!', stage: 2 },
  { source: '/audio/hurt-2-2.wav', text: '히잉…', stage: 2 },
  { source: '/audio/hurt-2-3.wav', text: '왜 때려!', stage: 2 },
]

interface WakeLockSentinelLike extends EventTarget {
  released: boolean
  release(): Promise<void>
}

export default function App() {
  const [expression, setExpression] = useState<Expression>('happy')
  const [glitchKey, setGlitchKey] = useState(0)
  const [glitching, setGlitching] = useState(false)
  const [hurtBubble, setHurtBubble] = useState('')
  const [bubblePlacement, setBubblePlacement] = useState<BubblePlacement>('top-right')
  const [adminOpen, setAdminOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement))
  const secretTapRef = useRef({ count: 0, lastTap: 0 })
  const audioPlayersRef = useRef<HTMLAudioElement[]>([])
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  const lastAudioIndexRef = useRef<Record<HurtStage, number>>({ 1: -1, 2: -1 })
  const lastBubblePlacementRef = useRef<BubblePlacement>('top-right')
  const glitchTimerRef = useRef<number | null>(null)
  const surpriseTimerRef = useRef<number | null>(null)
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null)
  const { videoRef, status, startCamera, stopCamera, captureFrame } = useCamera()

  // 관리자 패널은 카메라 상태를 확인하는 도구일 뿐이다. 앱이 열리면 패널을 거치지
  // 않고 바로 카메라와 사람 인식을 준비하고, 권한 요청이 막히면 기존처럼 첫 터치에서 재시도한다.
  useEffect(() => {
    void startCamera()
  }, [startCamera])

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

  // 아파하는 반응: 글리치 + 아픈 표정 + 녹음 재생. 화면 탭과 ESP32 피에조 충격이 같이 쓴다.
  const triggerHurt = useCallback((stage: HurtStage = 1) => {
    if (surpriseTimerRef.current) window.clearTimeout(surpriseTimerRef.current)
    setExpression('hurt')
    setGlitchKey((current) => current + 1)
    setGlitching(true)
    if (glitchTimerRef.current) window.clearTimeout(glitchTimerRef.current)
    glitchTimerRef.current = window.setTimeout(() => setGlitching(false), 620)
    const candidates = HURT_VOICES.map((voice, index) => ({ voice, index })).filter(({ voice }) => voice.stage === stage)
    if (audioPlayersRef.current.length && candidates.length) {
      let candidateIndex = Math.floor(Math.random() * candidates.length)
      if (candidates.length > 1 && candidates[candidateIndex].index === lastAudioIndexRef.current[stage]) {
        candidateIndex = (candidateIndex + 1 + Math.floor(Math.random() * (candidates.length - 1))) % candidates.length
      }
      const { voice, index: nextIndex } = candidates[candidateIndex]
      currentAudioRef.current?.pause()
      if (currentAudioRef.current) currentAudioRef.current.currentTime = 0
      const player = audioPlayersRef.current[nextIndex]
      player.currentTime = 0
      const placements = BUBBLE_PLACEMENTS.filter((placement) => placement !== lastBubblePlacementRef.current)
      const nextPlacement = placements[Math.floor(Math.random() * placements.length)]
      lastBubblePlacementRef.current = nextPlacement
      setBubblePlacement(nextPlacement)
      setHurtBubble(voice.text)
      const finish = () => {
        if (currentAudioRef.current !== player) return
        setExpression('happy')
        setHurtBubble('')
      }
      player.onended = finish
      player.onerror = finish
      currentAudioRef.current = player
      lastAudioIndexRef.current[stage] = nextIndex
      // 소리를 못 내도(자동 재생 차단 등) 아픈 표정은 잠깐 보여준다.
      void player.play().catch(() => window.setTimeout(finish, 1500))
    } else window.setTimeout(() => { setExpression('happy'); setHurtBubble('') }, 1500)
  }, [])

  const triggerSurprised = useCallback(() => {
    currentAudioRef.current?.pause()
    if (currentAudioRef.current) currentAudioRef.current.currentTime = 0
    setHurtBubble('')
    setExpression('surprised')
    if (surpriseTimerRef.current) window.clearTimeout(surpriseTimerRef.current)
    surpriseTimerRef.current = window.setTimeout(() => {
      setExpression('happy')
      surpriseTimerRef.current = null
    }, 1500)
  }, [])

  // iPhone은 사용자가 화면을 만진 뒤에만 소리를 낼 수 있다. 첫 터치 때 녹음을 모두 소리 없이
  // 한 번 재생해 두면, 이후 피에조 충격처럼 터치 없이 온 신호에도 소리가 난다.
  const audioUnlockedRef = useRef(false)
  const unlockAudio = useCallback(() => {
    if (audioUnlockedRef.current) return
    audioUnlockedRef.current = true
    audioPlayersRef.current.forEach((player) => {
      player.muted = true
      void player.play().then(() => {
        if (player !== currentAudioRef.current) { player.pause(); player.currentTime = 0 }
      }).catch(() => undefined).finally(() => { player.muted = false })
    })
  }, [])

  const handleTouch = useCallback((event: React.PointerEvent<HTMLElement>) => {
    unlockAudio()
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
    triggerHurt()
    void startCamera()
    void requestWakeLock()
  }, [requestWakeLock, startCamera, triggerHurt, unlockAudio])

  // 로봇(ESP32) 주행 켜기/끄기. 서버가 상태를 들고 있고 ESP32가 1초마다 확인한다.
  const [robot, setRobot] = useState<RobotStatus | null>(null)
  const [robotBusy, setRobotBusy] = useState(false)
  useEffect(() => {
    let stopped = false
    const load = () => fetch('/api/robot').then((r) => r.ok ? r.json() as Promise<RobotStatus> : null)
      .then((status) => { if (!stopped && status) setRobot(status) }).catch(() => undefined)
    void load()
    const timer = window.setInterval(load, 2000)  // ESP32 연결·반영 표시 갱신
    return () => { stopped = true; window.clearInterval(timer) }
  }, [])
  const toggleRobot = useCallback(async () => {
    const driving = !(robot?.driving ?? true)
    setRobotBusy(true)
    // 누르자마자 스위치가 넘어가게 하고, 로봇이 따라오면 "반영됨"으로 바뀐다
    setRobot((current) => current ? { ...current, driving, synced: false, changedBy: 'panel' } : current)
    try {
      const response = await fetch('/api/robot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driving, source: 'panel' }),
      })
      if (response.ok) setRobot(await response.json() as RobotStatus)
    } catch {
      // 네트워크 오류: 버튼 상태가 그대로 남는다.
    } finally {
      setRobotBusy(false)
    }
  }, [robot?.driving])
  const robotSync: { kind: 'ok' | 'pending' | 'off'; text: string } = !robot
    ? { kind: 'pending', text: '' }
    : !robot.online
      ? { kind: 'off', text: `로봇 연결 안 됨${robot.seenMsAgo != null ? ` · 마지막 확인 ${agoText(robot.seenMsAgo)}` : ''} · 켜지면 이 설정을 따라요` }
      : robot.synced
        ? { kind: 'ok', text: `✓ 로봇에 반영됨${robot.changedBy === 'esp32' ? ' · 로봇 버튼으로 바뀜' : ''}` }
        : { kind: 'pending', text: '로봇에 전달 중…' }

  // ESP32 피에조 값: 300 이하는 놀라고, 그보다 크면 탭한 것처럼 아파한다.
  const [hurtLink, setHurtLink] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [piezo, setPiezo] = useState<PiezoDisplay | null>(null)
  const piezoRef = useRef<PiezoReading | null>(null)
  useEffect(() => {
    const events = new EventSource('/api/events')
    events.onopen = () => setHurtLink('open')
    events.onerror = () => setHurtLink(events.readyState === EventSource.CLOSED ? 'closed' : 'connecting')
    events.addEventListener('hurt', (event) => {
      let stage: HurtStage = 1
      try {
        const reading = JSON.parse((event as MessageEvent<string>).data) as PiezoReading
        if (typeof reading.level === 'number' && (reading.stage === 1 || reading.stage === 2)) {
          stage = reading.stage
          piezoRef.current = reading
          setPiezo(reading)
        }
      } catch {
        // 예전 서버 형식이어도 아픈 반응 자체는 유지한다.
      }
      triggerHurt(stage)
    })
    events.addEventListener('surprised', (event) => {
      try {
        const reading = JSON.parse((event as MessageEvent<string>).data) as { level?: unknown }
        if (typeof reading.level === 'number') {
          setPiezo({ level: reading.level, reaction: 'surprised' })
        }
      } catch {
        // 데이터 표시를 못 해도 놀란 표정은 보여준다.
      }
      triggerSurprised()
    })
    events.addEventListener('robot', (event) => {
      try { setRobot(JSON.parse((event as MessageEvent<string>).data) as RobotStatus) } catch { /* 무시 */ }
    })
    return () => events.close()
  }, [triggerHurt, triggerSurprised])

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

  const [capture, setCapture] = useState<CaptureState>({ kind: 'idle', message: '' })
  const [publishingRestartBusy, setPublishingRestartBusy] = useState(false)
  const restartPublishing = useCallback(async () => {
    setPublishingRestartBusy(true)
    setCapture({ kind: 'busy', message: '게시 작업 재시작 중…' })
    try {
      const response = await fetch('/api/publishing/restart', { method: 'POST' })
      setCapture(response.ok
        ? { kind: 'ok', message: '게시 작업을 중단 후 재개했습니다' }
        : { kind: 'error', message: `게시 작업 재시작 실패 (${response.status})` })
    } catch {
      setCapture({ kind: 'error', message: '게시 작업 재시작 실패 (네트워크)' })
    } finally {
      setPublishingRestartBusy(false)
    }
  }, [])
  const [publication, setPublication] = useState<PublicationStatus | null>(null)
  const [publicationConnection, setPublicationConnection] = useState<PublicationConnection>('connecting')

  // 취재: 사람을 보면 사진(config의 VISIT.photoDelaysMs, 지금은 1장)을 찍어 /api/observations 로 보내고, 발화가 끝날 때까지 들은 말을
  // 글자로 바꿔 /api/transcripts 로 보낸다. 이후 published 신호가 올 때까지 사람 인식과 다음 취재를 멈춘다.
  const [visit, setVisit] = useState<VisitState>({ phase: 'idle', photos: 0, until: 0 })
  const visitPhaseRef = useRef<VisitState['phase']>('idle')
  const publicationAbortRef = useRef<AbortController | null>(null)
  const [, setClockTick] = useState(0)
  useEffect(() => {
    if (visit.phase === 'idle') return
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 500)
    return () => window.clearInterval(timer)
  }, [visit.phase])

  const runVisit = useCallback(async (detectedFrame?: Blob | null) => {
    if (visitPhaseRef.current !== 'idle') return
    if (!OBSERVATION_URL || !OBSERVATION_TOKEN) {
      setCapture({ kind: 'error', message: OBSERVATION_URL ? '토큰 미설정' : 'API 경로 미설정' })
      return
    }
    visitPhaseRef.current = 'running'
    setPublication(null)
    const startedAt = Date.now()
    setVisit({ phase: 'running', photos: 0, until: startedAt + VISIT.maxListenMs })
    setCapture({ kind: 'busy', message: '' })
    await startCamera()

    let speech: SpeechSession | null = null
    try { speech = startListening('ko-KR') } catch { speech = null }

    let photosSent = 0
    const publicationEventIds: string[] = []
    const photoJobs = VISIT.photoDelaysMs.map((delay, index) => sleep(delay).then(async () => {
      // 첫 사진은 사람이 있다고 판정한 바로 그 프레임을 사용한다. 상태 변경과
      // JPEG 변환 사이에 사람이 움직여 배경만 찍히는 일을 피한다.
      const photo = index === 0 && detectedFrame ? detectedFrame : await captureFrame()
      if (!photo) return
      try {
        const reading = piezoRef.current
        // 피에조 단계는 다음 관찰 POST 한 번에만 포함한다. 여러 사진이 동시에
        // 전송되더라도 첫 번째 작업이 값을 가져가면 나머지는 기본 단계로 전송된다.
        if (reading) {
          piezoRef.current = null
          setPiezo(null)
        }
        const { response, eventId } = await sendObservation({
          image: photo,
          sensors: reading ? { piezoLevel: reading.stage } : {},
        })
        if (response.ok) {
          publicationEventIds.push(eventId)
          photosSent += 1
          setVisit((current) => ({ ...current, photos: photosSent }))
        }
      } catch {
        // 네트워크 오류: 아래 결과 메시지에 장수로만 드러난다.
      }
    }))

    if (speech) await speech.waitForPause(VISIT.silenceMs, VISIT.noSpeechMs, VISIT.maxListenMs)
    else await sleep(VISIT.noSpeechMs)
    const text = speech ? await speech.stop() : ''
    await Promise.all(photoJobs)

    let transcriptResult: string
    if (!speech) transcriptResult = '음성 인식 미지원'
    else if (!text) transcriptResult = speech.lastError() === 'not-allowed' ? '마이크 거부' : '말소리 없음'
    else {
      try {
        const response = await sendTranscript(text)
        transcriptResult = response.ok ? '대화 전송' : `대화 실패 ${response.status}`
      } catch {
        transcriptResult = '대화 실패(네트워크)'
      }
    }
    const allOk = photosSent === VISIT.photoDelaysMs.length && transcriptResult === '대화 전송'
    setCapture({ kind: allOk ? 'ok' : 'error', message: `사진 ${photosSent}/${VISIT.photoDelaysMs.length} · ${transcriptResult}` })
    setLastTranscript(text)

    if (!publicationEventIds.length) {
      visitPhaseRef.current = 'idle'
      setVisit({ phase: 'idle', photos: 0, until: 0 })
      return
    }

    visitPhaseRef.current = 'processing'
    setVisit({ phase: 'processing', photos: photosSent, until: 0, eventId: publicationEventIds[0] })
    const controller = new AbortController()
    publicationAbortRef.current = controller
    try {
      const completed = await waitForAnyPublication(publicationEventIds, controller.signal, (update) => {
        if (update.kind === 'connection') setPublicationConnection(update.connection)
        else setPublication(update.publication)
      })
      setCapture({
        kind: 'ok',
        message: isPublished(completed.status)
          ? `게시 완료 · ${completed.eventId}`
          : `게시 관리자 전달 완료 · ${completed.eventId}`,
      })
    } catch {
      if (!controller.signal.aborted) setCapture({ kind: 'error', message: '게시 확인 연결 실패' })
      return
    } finally {
      if (publicationAbortRef.current === controller) publicationAbortRef.current = null
    }
    visitPhaseRef.current = 'idle'
    setVisit({ phase: 'idle', photos: 0, until: 0 })
  }, [captureFrame, startCamera])

  const [lastTranscript, setLastTranscript] = useState('')
  const [autoCapture, setAutoCapture] = useState(true)
  const onPersonPresent = useCallback((detectedFrame: Blob | null) => {
    void runVisit(detectedFrame)
  }, [runVisit])
  const detector = usePersonDetector(
    videoRef,
    autoCapture && status === 'active' && visit.phase === 'idle',
    AUTO_CAPTURE,
    onPersonPresent,
  )

  const secondsLeft = Math.max(0, Math.ceil((visit.until - Date.now()) / 1000))
  const publicationText = publication
    ? `${publicationStage(publication)}${publication.error ? ` · ${publication.error}` : ''}`
    : publicationConnection === 'reconnecting' ? '상태 연결 재시도 중' : '게시 상태 연결 중'
  const statusText = visit.phase === 'running'
    ? `취재 중 · 사진 ${visit.photos}/${VISIT.photoDelaysMs.length} · 듣기 ${secondsLeft}초`
    : visit.phase === 'processing'
      ? publicationText
      : capture.message
  const articleGenerating = visit.phase === 'processing'
    && Boolean(publication && isArticleGenerating(publication.status))
  const instagramPublishing = visit.phase === 'processing'
    && Boolean(publication && isInstagramPublishing(publication.status))
  const faceExpression: Expression = expression === 'hurt'
    ? 'hurt'
    : instagramPublishing
      ? 'wink'
      : articleGenerating
        ? 'thinking'
        : expression

  useEffect(() => {
    audioPlayersRef.current = HURT_VOICES.map(({ source }) => {
      const audio = new Audio(source)
      audio.preload = 'auto'
      return audio
    })
    return () => {
      publicationAbortRef.current?.abort()
      if (glitchTimerRef.current) window.clearTimeout(glitchTimerRef.current)
      if (surpriseTimerRef.current) window.clearTimeout(surpriseTimerRef.current)
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
        <RobotFace expression={faceExpression} recording={visit.phase === 'running'} />
      </div>
      {hurtBubble && (
        <div
          key={`${glitchKey}-${hurtBubble}`}
          className={`hurt-bubble hurt-bubble-${bubblePlacement}`}
          role="status"
          aria-live="assertive"
        >
          {hurtBubble}
        </div>
      )}
      {glitching && <div key={glitchKey} className="glitch-overlay" aria-hidden="true" />}
      {import.meta.env.DEV && <div className={`camera-status status-${status}`}>camera: {status}</div>}
      <section
        className={`admin-panel${adminOpen ? ' is-open' : ''}`}
        onPointerUp={(event) => event.stopPropagation()}
        aria-label="관리자 패널"
        aria-hidden={!adminOpen}
      >
          <header className="admin-header">
            <div>
              <p className="admin-kicker">
                ROBOT FACE · 피에조 {hurtLink === 'open' ? '연결됨' : hurtLink === 'connecting' ? '연결 중' : '끊김'}
                {piezo ? ` · ${'stage' in piezo ? `${piezo.stage}단계` : '놀람'} ${piezo.level}` : ''}
                {robot ? ` · 로봇 ${robot.online ? '연결됨' : '안 보임'}` : ''}
              </p>
              <h1>관리자 패널</h1>
            </div>
            {statusText && <p className={`capture-status capture-${visit.phase === 'running' ? 'busy' : publication && isPublicationProblem(publication.status) ? 'error' : capture.kind}`} role="status">{statusText}</p>}
            <button className="icon-button" type="button" onClick={() => setAdminOpen(false)} aria-label="관리자 패널 닫기">×</button>
          </header>

          <div className="admin-camera-card">
            <div className="camera-frame">
              <video ref={videoRef} className="camera-video" playsInline muted autoPlay />
            </div>
            <div className="camera-meta">
              <span className={`status-dot status-${status}`} />
              <span>전면 카메라</span>
              <span className={`person-meta${detector.person && detector.person.score >= AUTO_CAPTURE.minScore ? ' is-present' : ''}`}>
                {detector.state === 'off' ? (autoCapture ? '사람 인식 대기' : '사람 인식 꺼짐')
                  : detector.state === 'loading' ? '사람 인식 준비 중…'
                  : detector.state === 'error' ? '사람 인식 실패'
                  : detector.person && detector.person.score >= AUTO_CAPTURE.minScore
                    ? `사람 ${Math.round(detector.person.score * 100)}%`
                    : '사람 없음'}
              </span>
              <strong>{status === 'active' ? '정상 작동 중' : status}</strong>
            </div>
            {lastTranscript && <p className="last-transcript">“{lastTranscript}”</p>}
          </div>

          <div className="admin-controls">
            <div className={`robot-card ${robot?.driving ?? true ? 'is-driving' : 'is-stopped'}`}>
              <div className="robot-card-text">
                <span className="robot-card-label">로봇 주행</span>
                <strong>{!robot ? '불러오는 중…' : robot.driving ? '켜짐 · 돌아다니는 중' : '꺼짐 · 멈춰 있음'}</strong>
                <span className={`robot-sync robot-sync-${robotSync.kind}`}>{robotSync.text}</span>
              </div>
              <button
                type="button"
                role="switch"
                className="robot-switch"
                aria-checked={robot?.driving ?? false}
                aria-label="로봇 주행 켜기/끄기"
                onClick={() => { void toggleRobot() }}
                disabled={!robot || robotBusy}
              >
                <span className="robot-switch-knob" />
              </button>
            </div>
            <div className="admin-actions">
            <button
              type="button"
              className={autoCapture ? 'is-on' : undefined}
              onClick={() => setAutoCapture((on) => !on)}
              aria-pressed={autoCapture}
            >
              <span className="action-icon">◉</span>
              <span>자동 촬영 {autoCapture ? '켜짐' : '꺼짐'}</span>
            </button>
            <button
              type="button"
              className={visit.phase === 'running' ? 'is-recording' : undefined}
              onClick={() => { void runVisit() }}
              disabled={visit.phase !== 'idle'}
            >
              <span className="action-icon">●</span>
              <span>지금 취재</span>
            </button>
            <button type="button" onClick={toggleFullscreen}>
              <span className="action-icon">{isFullscreen ? '↙' : '↗'}</span>
              <span>{isFullscreen ? '전체화면 종료' : '전체화면 시작'}</span>
            </button>
            <button type="button" onClick={restartCamera}>
              <span className="action-icon">↻</span>
              <span>카메라 재시작</span>
            </button>
            <button
              type="button"
              onClick={() => { void restartPublishing() }}
              disabled={publishingRestartBusy}
            >
              <span className="action-icon">↻</span>
              <span>{publishingRestartBusy ? '게시 재시작 중…' : '게시 재시작'}</span>
            </button>
            </div>

            <p className="admin-note">iPhone Safari에서는 홈 화면에 추가한 앱으로 실행하면 가장 넓은 화면을 사용할 수 있습니다.</p>
          </div>
        </section>
    </main>
  )
}

declare global {
  interface Window {
    captureFrame?: () => Promise<Blob | null>
  }
}
