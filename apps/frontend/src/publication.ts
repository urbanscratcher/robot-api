import { OBSERVATION_TOKEN, PUBLICATIONS_URL } from './config'

export interface PublicationStatus {
  eventId: string
  status: string
  phase?: string | null
  mediaId?: string | null
  publishedAt?: string | null
  message?: string | null
  error?: string | null
  current?: number | null
  total?: number | null
  cardIndex?: number | null
  cardTotal?: number | null
  [key: string]: unknown
}

export type PublicationConnection = 'connecting' | 'open' | 'reconnecting'
export type PublicationUpdate =
  | { kind: 'status'; publication: PublicationStatus }
  | { kind: 'connection'; eventId: string; connection: PublicationConnection }

type UpdateHandler = (update: PublicationUpdate) => void

const normalizeStatus = (status: string) => status.trim().toLowerCase().replace(/[\s-]+/g, '_')
export const isPublished = (status: string) => normalizeStatus(status) === 'published'
export const isPublicationHandedOff = (status: string) =>
  normalizeStatus(status) === 'unknown'
export const isArticleGenerating = (status: string) =>
  ['ai_generating', 'generating', 'article_generating', 'generating_article'].includes(normalizeStatus(status))
export const isInstagramPublishing = (status: string) =>
  ['publishing', 'instagram_publishing'].includes(normalizeStatus(status))

const isTerminalForCapture = (status: string) => isPublished(status) || isPublicationHandedOff(status)

export function publicationStage(publication: PublicationStatus) {
  const status = normalizeStatus(publication.status)
  const current = publication.current ?? publication.cardIndex
  const total = publication.total ?? publication.cardTotal
  const cardCount = current && total ? ` ${current}/${total}` : ''
  const stages: Record<string, string> = {
    received: '',
    photo_received: '',
    observation_received: '',
    queued: 'AI 생성 대기 중',
    draft: 'AI 생성 대기 중',
    ai_generating: 'AI 기사 생성 중',
    generating: 'AI 기사 생성 중',
    article_generating: 'AI 기사 생성 중',
    generating_article: 'AI 기사 생성 중',
    cards_generating: `카드뉴스 생성 중${cardCount}`,
    carousel_generating: `카드뉴스 생성 중${cardCount}`,
    card_news_generating: `카드뉴스 생성 중${cardCount}`,
    generating_cards: `카드뉴스 생성 중${cardCount}`,
    review_required: '게시 확인 필요',
    needs_review: '게시 확인 필요',
    ready_for_publish: '게시 확인 필요',
    publish_pending: '인스타 게시 대기 중',
    publishing: '인스타 게시 중',
    instagram_publishing: '인스타 게시 중',
    published: '인스타 게시 완료',
    unknown: '게시 확인 필요',
    failed: '처리 실패',
    error: '처리 실패',
  }
  return stages[status] ?? publication.phase ?? publication.message ?? publication.status
}

export function isPublicationProblem(status: string) {
  return ['failed', 'error', 'review_required', 'needs_review', 'ready_for_publish', 'unknown']
    .includes(normalizeStatus(status))
}

function headers() {
  return { Authorization: `Bearer ${OBSERVATION_TOKEN}` }
}

async function getPublication(eventId: string, signal: AbortSignal) {
  const response = await fetch(`${PUBLICATIONS_URL}/${encodeURIComponent(eventId)}`, {
    headers: headers(),
    signal,
  })
  if (!response.ok) throw new Error(`publication status ${response.status}`)
  return response.json() as Promise<PublicationStatus>
}

function parseEvent(block: string): PublicationStatus | null {
  const lines = block.split(/\r?\n/)
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return null
  const parsed = JSON.parse(data) as PublicationStatus
  const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim()
  if (!parsed.status && event && event !== 'status') parsed.status = event
  return parsed.status ? parsed : null
}

const reconnectDelay = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = window.setTimeout(resolve, 3000)
  signal.addEventListener('abort', () => {
    window.clearTimeout(timer)
    reject(signal.reason)
  }, { once: true })
})

async function waitForPublication(eventId: string, signal: AbortSignal, onUpdate?: UpdateHandler) {
  let attempts = 0
  while (!signal.aborted) {
    onUpdate?.({ kind: 'connection', eventId, connection: attempts ? 'reconnecting' : 'connecting' })
    try {
      // 재연결 전에 현재 상태를 조회하므로 연결이 끊긴 사이의 published도 놓치지 않는다.
      const current = await getPublication(eventId, signal)
      onUpdate?.({ kind: 'status', publication: current })
      // 검토 대기는 아직 게시 흐름이 끝난 상태가 아니다. 관리자가 승인한 뒤 이어지는
      // publishing과 published를 받아야 하므로 SSE 연결을 계속 유지한다.
      if (isTerminalForCapture(current.status)) return current

      const response = await fetch(`${PUBLICATIONS_URL}/${encodeURIComponent(eventId)}/events`, {
        headers: { ...headers(), Accept: 'text/event-stream' },
        signal,
      })
      if (!response.ok || !response.body) throw new Error(`publication events ${response.status}`)
      onUpdate?.({ kind: 'connection', eventId, connection: 'open' })
      attempts += 1

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const publication = parseEvent(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
          if (publication) {
            onUpdate?.({ kind: 'status', publication })
            if (isTerminalForCapture(publication.status)) return publication
          }
          boundary = buffer.indexOf('\n\n')
        }
        if (done) break
      }
    } catch (error) {
      if (signal.aborted) throw error
    }
    attempts += 1
    onUpdate?.({ kind: 'connection', eventId, connection: 'reconnecting' })
    await reconnectDelay(signal)
  }
  throw signal.reason
}

// 한 번의 취재에서 사진별 eventId가 생긴다. 게시 완료(또는 후속 상태를 확인할 수 없는
// unknown)에 도달하면 촬영 단말의 역할이 끝났으므로 나머지 연결을 닫는다.
export async function waitForAnyPublication(eventIds: string[], signal?: AbortSignal, onUpdate?: UpdateHandler) {
  if (!eventIds.length) throw new Error('no publication event')
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race(eventIds.map((eventId) => waitForPublication(eventId, controller.signal, onUpdate)))
  } finally {
    controller.abort()
    signal?.removeEventListener('abort', abort)
  }
}
