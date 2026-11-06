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
  // 듣기를 끝내고 지금까지 받아쓴 글을 돌려준다.
  stop(): Promise<string>
  // 오류가 있었다면 마지막 오류 이름 (not-allowed: 마이크 권한 거부 등)
  lastError(): string | null
}

// 듣기 시작. 말이 끊겨 브라우저가 스스로 멈추면 stop()을 부를 때까지 다시 시작한다.
export function startListening(lang = 'ko-KR'): SpeechSession {
  const Recognition = getRecognition()
  if (!Recognition) throw new Error('speech recognition unsupported')

  const finals: string[] = []
  let interim = ''
  let active = true
  let error: string | null = null
  let recognition: RecognitionLike
  let ended: (() => void) | null = null

  const begin = () => {
    recognition = new Recognition()
    recognition.lang = lang
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onresult = (event) => {
      interim = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        const text = result[0].transcript.trim()
        if (!text) continue
        if (result.isFinal) finals.push(text)
        else interim += `${text} `
      }
    }
    recognition.onerror = (event) => {
      error = event.error
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') active = false
    }
    recognition.onend = () => {
      if (interim.trim()) { finals.push(interim.trim()); interim = '' }
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
    stop: () => new Promise<string>((resolve) => {
      const finish = () => resolve([...finals, interim.trim()].filter(Boolean).join(' '))
      if (!active) { finish(); return }
      active = false
      const timeout = window.setTimeout(() => { recognition.abort(); finish() }, 2000)
      ended = () => { window.clearTimeout(timeout); finish() }
      recognition.stop()
    }),
  }
}
