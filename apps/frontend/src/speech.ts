// 휴대폰 브라우저의 음성 인식(Web Speech API)으로 말소리를 글자로 바꾼다.
// iPhone Safari·Chrome에서 동작한다. 지원하지 않는 브라우저에서는 isSpeechSupported()가 false.

interface RecognitionResultLike { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEventLike { resultIndex: number; results: ArrayLike<RecognitionResultLike> }
interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: RecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionConstructor = new () => RecognitionLike

function getRecognition(): RecognitionConstructor | undefined {
  const w = window as Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export const isSpeechSupported = () => Boolean(getRecognition())

export interface SpeechSession {
  // 말이 시작된 뒤 일정 시간 새 결과가 없거나, 아무 말도 없는 제한 시간이 지나면 끝낸다.
  waitForPause(silenceMs: number, noSpeechMs: number, maxMs: number): Promise<void>
  // 듣기를 끝내고 지금까지 받아쓴 글을 돌려준다.
  stop(): Promise<string>
  // 오류가 있었다면 마지막 오류 이름 (not-allowed: 마이크 권한 거부 등)
  lastError(): string | null
}

const squash = (text: string) => text.replace(/\s+/g, '')

// 받아쓴 조각들을 겹치지 않게 합친다.
// iPhone Safari는 같은 문장을 여러 번 다시 보내거나, 뒤 조각에 앞 조각을 통째로 담아 보낸다.
// - 뒤 조각이 앞 조각을 포함하면(이어 말하는 중) 앞 조각을 뒤 조각으로 바꾼다.
// - 이미 받은 조각에 들어 있는 조각이면 버린다.
export function mergeSegments(segments: string[]): string[] {
  const out: string[] = []
  for (const raw of segments) {
    const text = raw.trim().replace(/\s+/g, ' ')
    const key = squash(text)
    if (!key) continue
    if (out.some((kept) => squash(kept).includes(key))) continue
    const last = out[out.length - 1]
    if (last && key.includes(squash(last))) out[out.length - 1] = text
    else out.push(text)
  }
  return out
}

// 같은 말(1~12어절)이 연달아 반복되면 한 번만 남긴다. 예) "안녕하세요 안녕하세요 반가워요" → "안녕하세요 반가워요"
export function collapseRepeats(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  for (let size = Math.min(12, Math.floor(words.length / 2)); size >= 1; size -= 1) {
    for (let i = 0; i + size * 2 <= words.length; ) {
      const a = words.slice(i, i + size).join(' ')
      const b = words.slice(i + size, i + size * 2).join(' ')
      if (squash(a) === squash(b)) words.splice(i + size, size)
      else i += 1
    }
  }
  return words.join(' ')
}

export function cleanTranscript(segments: string[]): string {
  return collapseRepeats(mergeSegments(segments).join(' '))
}

// 듣기 시작. 말이 끊겨 브라우저가 스스로 멈추면 stop()을 부를 때까지 다시 시작한다.
export function startListening(lang = 'ko-KR'): SpeechSession {
  const Recognition = getRecognition()
  if (!Recognition) throw new Error('speech recognition unsupported')

  // 끝난 인식 회차들의 글 + 지금 회차의 글. 지금 회차는 결과가 올 때마다 처음부터 다시 만든다
  // (resultIndex를 믿고 이어 붙이면 Safari에서 같은 문장이 계속 쌓인다).
  const committed: string[] = []
  let current: string[] = []
  let active = true
  let error: string | null = null
  let recognition: RecognitionLike
  let ended: (() => void) | null = null
  let heardSpeech = false
  let lastResultAt = 0
  let activityChanged: (() => void) | null = null

  const begin = () => {
    current = []
    recognition = new Recognition()
    recognition.lang = lang
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onresult = (event) => {
      // Safari/iOS에서는 stop() 직전까지 결과가 isFinal=false인 채로 남는 경우가 있다.
      // 화면에 실제로 나타난 인식 결과를 모두 보관해야 마지막 문장이 사라지지 않는다.
      const visibleSegments: string[] = []
      for (let i = 0; i < event.results.length; i += 1) {
        const text = event.results[i][0].transcript.trim()
        if (!text) continue
        heardSpeech = true
        lastResultAt = Date.now()
        visibleSegments.push(text)
      }
      current = mergeSegments(visibleSegments)
      activityChanged?.()
    }
    recognition.onerror = (event) => {
      error = event.error
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') active = false
    }
    recognition.onend = () => {
      committed.push(...current)
      current = []
      if (active) {
        try { begin() } catch { active = false }
      }
      if (!active) ended?.()
    }
    recognition.start()
  }
  begin()

  return {
    lastError: () => error,
    waitForPause: (silenceMs, noSpeechMs, maxMs) => new Promise<void>((resolve) => {
      const startedAt = Date.now()
      let timer = 0
      const check = () => {
        window.clearTimeout(timer)
        const now = Date.now()
        const elapsed = now - startedAt
        const quietFor = heardSpeech ? now - lastResultAt : elapsed
        const limit = heardSpeech ? silenceMs : noSpeechMs
        if (quietFor >= limit || elapsed >= maxMs || !active) {
          activityChanged = null
          resolve()
          return
        }
        timer = window.setTimeout(check, Math.min(limit - quietFor, maxMs - elapsed))
      }
      activityChanged = check
      check()
    }),
    stop: () => new Promise<string>((resolve) => {
      const finish = () => resolve(cleanTranscript([...committed, ...current]))
      if (!active) { finish(); return }
      active = false
      const timeout = window.setTimeout(() => { recognition.abort(); finish() }, 2000)
      ended = () => { window.clearTimeout(timeout); finish() }
      recognition.stop()
    }),
  }
}
