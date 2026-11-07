import { localFetch, fail } from "./local.ts";
import { cleanTranscript, type SpeechSegment } from "../src/transcript.ts";
export function inspectWav(raw: Buffer) {
  if (
    raw.length < 44 ||
    raw.toString("ascii", 0, 4) !== "RIFF" ||
    raw.toString("ascii", 8, 12) !== "WAVE"
  )
    fail("녹음 파일을 읽지 못했습니다. 다시 녹음해주세요.");
  let format = false,
    start = -1,
    length = 0;
  for (let p = 12; p + 8 <= raw.length; ) {
    const name = raw.toString("ascii", p, p + 4),
      size = raw.readUInt32LE(p + 4),
      body = p + 8;
    if (body + size > raw.length)
      fail("녹음 파일이 잘렸습니다. 다시 녹음해주세요.");
    if (name === "fmt ") {
      if (
        size < 16 ||
        raw.readUInt16LE(body) !== 1 ||
        raw.readUInt16LE(body + 2) !== 1 ||
        raw.readUInt32LE(body + 4) !== 16000 ||
        raw.readUInt16LE(body + 14) !== 16
      )
        fail("16kHz 모노 WAV 녹음이 필요합니다.");
      format = true;
    }
    if (name === "data") {
      start = body;
      length = size;
    }
    p = body + size + (size % 2);
  }
  if (!format || start < 0 || length % 2)
    fail("녹음 파일 형식이 유효하지 않습니다.");
  let squares = 0;
  for (let p = start; p < start + length; p += 2) {
    const sample = raw.readInt16LE(p) / 32768;
    squares += sample * sample;
  }
  return {
    duration: length / 32000,
    rms: length ? Math.sqrt(squares / (length / 2)) : 0,
  };
}
export async function transcribeAudio(raw: Buffer, whisper: string) {
  const audio = inspectWav(raw);
  if (audio.duration < 0.35 || audio.rms < 0.0001)
    return { text: "", segments: [], duration: audio.duration };
  const form = new FormData();
  form.append(
    "file",
    new Blob([raw], { type: "audio/wav" }),
    "conversation.wav",
  );
  for (const [key, value] of Object.entries({
    language: "ko",
    response_format: "verbose_json",
    translate: "false",
    temperature: "0.0",
    temperature_inc: "0.0",
    beam_size: "5",
    best_of: "5",
  }))
    form.append(key, value);
  const response = await localFetch(
    `${whisper}/inference`,
    { method: "POST", body: form },
    120000,
  ).catch(() =>
    fail(
      "Whisper 서버에 연결할 수 없습니다. 연결을 확인한 후 다시 녹음해주세요.",
      503,
    ),
  );
  if (!response.ok)
    fail(
      "음성 인식에 실패했습니다. Whisper 모델과 서버 상태를 확인해주세요.",
      502,
    );
  const data = await response.json();
  const segments: SpeechSegment[] = Array.isArray(data.segments)
    ? data.segments
        .map((s: { start?: number; end?: number; text?: string }) => ({
          start:
            typeof s.start === "number" && Number.isFinite(s.start)
              ? Math.max(0, s.start)
              : 0,
          end:
            typeof s.end === "number" && Number.isFinite(s.end)
              ? Math.min(audio.duration, s.end)
              : audio.duration,
          text: cleanTranscript(s.text),
        }))
        .filter((s: SpeechSegment) => s.text)
    : [];
  if (!segments.length) {
    const text = cleanTranscript(data.text);
    if (text) segments.push({ start: 0, end: audio.duration, text });
  }
  return {
    text: segments.map((s) => s.text).join(" "),
    segments,
    duration: audio.duration,
  };
}
