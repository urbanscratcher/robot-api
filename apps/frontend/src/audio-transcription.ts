export interface AudioTranscriptionSession {
  stop(): Promise<string>
  lastError(): string | null
}

async function wavFromBlob(blob: Blob): Promise<Blob> {
  const context = new AudioContext()
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer())
    const length = Math.ceil(audio.duration * 16000)
    const offline = new OfflineAudioContext(1, length, 16000)
    const source = offline.createBufferSource()
    source.buffer = audio
    source.connect(offline.destination)
    source.start()
    const samples = (await offline.startRendering()).getChannelData(0)
    const buffer = new ArrayBuffer(44 + samples.length * 2)
    const view = new DataView(buffer)
    const write = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)))
    write(0, 'RIFF')
    view.setUint32(4, buffer.byteLength - 8, true)
    write(8, 'WAVE')
    write(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 16000, true)
    view.setUint32(28, 32000, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    write(36, 'data')
    view.setUint32(40, samples.length * 2, true)
    samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767), true))
    return new Blob([buffer], { type: 'audio/wav' })
  } finally {
    await context.close()
  }
}

export async function startAudioTranscription(): Promise<AudioTranscriptionSession> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('recording-unsupported')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type))
  const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 128000 })
  const chunks: Blob[] = []
  let error: string | null = null
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
  recorder.onerror = () => { error = 'recording-failed' }
  recorder.start()

  return {
    lastError: () => error,
    stop: () => new Promise<string>((resolve) => {
      const finish = async () => {
        stream.getTracks().forEach((track) => track.stop())
        if (error || !chunks.length) { resolve(''); return }
        try {
          const wav = await wavFromBlob(new Blob(chunks, { type: recorder.mimeType }))
          const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || 'transcription-failed')
          resolve(typeof data.text === 'string' ? data.text.trim() : '')
        } catch (cause) {
          error = cause instanceof Error ? cause.message : 'transcription-failed'
          resolve('')
        }
      }
      recorder.onstop = () => { void finish() }
      if (recorder.state === 'recording') recorder.stop()
      else void finish()
    }),
  }
}
