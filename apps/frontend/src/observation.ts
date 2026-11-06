import { CAMERA_ID, OBSERVATION_TOKEN, OBSERVATION_URL, TRANSCRIPT_URL } from './config'

export interface Observation {
  eventId: string
  capturedAt: string
  sensors: Record<string, unknown>
  image?: string
}

export interface ObservationParts {
  image?: Blob | null
  sensors?: Record<string, unknown>
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0')

// 2026-11-06T15:30:00+09:00 (기기의 현지 시간대 기준)
export function localIsoString(date: Date) {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

// camera-1-20261106-001: 날짜별로 001부터 올라가는 번호. 저장소를 못 쓰면 시분초로 대신합니다.
export function nextEventId(date: Date) {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  let sequence: string
  try {
    const key = `observation-seq-${day}`
    const next = Number(localStorage.getItem(key) ?? '0') + 1
    localStorage.setItem(key, String(next))
    sequence = pad(next, 3)
  } catch {
    sequence = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  }
  return `${CAMERA_ID}-${day}-${sequence}`
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function buildObservation(parts: ObservationParts, capturedAt = new Date()): Promise<Observation> {
  const observation: Observation = {
    eventId: nextEventId(capturedAt),
    capturedAt: localIsoString(capturedAt),
    sensors: parts.sensors ?? {},
  }
  if (parts.image) observation.image = await blobToDataUrl(parts.image)
  return observation
}

function postJson(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(OBSERVATION_TOKEN ? { Authorization: `Bearer ${OBSERVATION_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

export async function sendObservation(parts: ObservationParts, url = OBSERVATION_URL) {
  const observation = await buildObservation(parts)
  const response = await postJson(url, observation)
  return { response, eventId: observation.eventId }
}

// 휴대폰에서 글자로 바꾼 대화 내용. 서버 규칙: 비어 있지 않고 12,000자 이내.
export function sendTranscript(text: string, url = TRANSCRIPT_URL) {
  return postJson(url, { text: text.trim().slice(0, 12000) })
}
