import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ObjectDetector } from '@mediapipe/tasks-vision'

// MediaPipe 물체 인식(EfficientDet-Lite0)으로 카메라에 사람이 있는지 본다.
// wasm 파일 버전은 package.json의 @mediapipe/tasks-vision 버전과 맞춘다.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite'

export interface PersonDetectorOptions {
  intervalMs: number        // 몇 ms마다 한 번 볼지
  minScore: number          // 사람이라고 볼 확신도 (0~1)
  minAreaRatio: number      // 화면에서 사람 상자가 차지해야 하는 최소 비율 (멀리 지나가는 사람 제외)
  arriveChecks: number      // 연속 몇 번 보여야 "사람이 있다"로 볼지
}

export type DetectorState = 'off' | 'loading' | 'ready' | 'error'

let detectorPromise: Promise<ObjectDetector> | null = null
export function loadPersonDetector() {
  detectorPromise ??= (async () => {
    const { FilesetResolver, ObjectDetector } = await import('@mediapipe/tasks-vision')
    const vision = await FilesetResolver.forVisionTasks(WASM_URL)
    return ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      runningMode: 'VIDEO',
      categoryAllowlist: ['person'],
      scoreThreshold: 0.3,
      maxResults: 5,
    })
  })().catch((error) => {
    detectorPromise = null
    throw error
  })
  return detectorPromise
}

// 가장 확실한 사람 하나의 확신도와 화면 비율. 없으면 null.
export function findPerson(detector: ObjectDetector, source: HTMLVideoElement | HTMLCanvasElement, timestamp: number, minScore: number) {
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height
  if (!width || !height) return null
  let best: { score: number; areaRatio: number } | null = null
  for (const detection of detector.detectForVideo(source, timestamp).detections) {
    const score = detection.categories[0]?.score ?? 0
    const box = detection.boundingBox
    if (!box || score < minScore) continue
    const areaRatio = (box.width * box.height) / (width * height)
    if (!best || score > best.score) best = { score, areaRatio }
  }
  return best
}

// 사람이 연속 arriveChecks번 보이면, 보이는 동안 검사할 때마다 onPresent를 부른다.
// (언제 실제로 움직일지는 부르는 쪽이 정한다: 취재 중·쉬는 중이면 무시)
export function usePersonDetector(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  options: PersonDetectorOptions,
  onPresent: () => void,
) {
  const [state, setState] = useState<DetectorState>('off')
  const [person, setPerson] = useState<{ score: number; areaRatio: number } | null>(null)
  const onPresentRef = useRef(onPresent)
  onPresentRef.current = onPresent
  const { intervalMs, minScore, minAreaRatio, arriveChecks } = options

  useEffect(() => {
    if (!enabled) {
      setState('off')
      setPerson(null)
      return
    }
    let cancelled = false
    let timer: number | null = null
    let seenInRow = 0
    let lastTimestamp = 0
    setState('loading')

    void loadPersonDetector().then((detector) => {
      if (cancelled) return
      setState('ready')
      const tick = () => {
        if (cancelled) return
        const video = videoRef.current
        if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const timestamp = Math.max(performance.now(), lastTimestamp + 1)
          lastTimestamp = timestamp
          let found: { score: number; areaRatio: number } | null = null
          try {
            found = findPerson(detector, video, timestamp, minScore)
          } catch {
            found = null
          }
          const counts = found !== null && found.areaRatio >= minAreaRatio
          setPerson(found)
          seenInRow = counts ? seenInRow + 1 : 0
          if (seenInRow >= arriveChecks) onPresentRef.current()
        }
        timer = window.setTimeout(tick, intervalMs)
      }
      tick()
    }).catch(() => {
      if (!cancelled) setState('error')
    })

    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [enabled, videoRef, intervalMs, minScore, minAreaRatio, arriveChecks])

  return { state, person }
}
