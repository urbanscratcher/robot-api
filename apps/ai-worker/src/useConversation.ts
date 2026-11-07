import { useEffect, useRef, useState } from "react";
import { wavFromBlob } from "./media";
import { cleanTranscript, type SpeechSegment } from "./transcript";
export type ConversationClip = {
  id: string;
  time: number;
  text: string;
  pending?: boolean;
};
export function useConversation(onError: (message: string) => void, maxSeconds = 60) {
  const [clips, setClips] = useState<ConversationClip[]>([]),
    [recording, setRecording] = useState<
      "off" | "requesting" | "recording" | "finishing"
    >("off"),
    [levels, setLevels] = useState<number[]>(Array(32).fill(2)),
    [elapsed, setElapsed] = useState(0),
    [quiet, setQuiet] = useState(false),
    [device, setDevice] = useState("");
  const media = useRef<MediaStream | null>(null),
    recorder = useRef<MediaRecorder | null>(null),
    context = useRef<AudioContext | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    waveTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined),
    token = useRef(0),
    epoch = useRef(0),
    offset = useRef(0),
    requests = useRef(new Map<string, AbortController>()),
    state = useRef(recording);
  function changeState(next: typeof recording) {
    state.current = next;
    setRecording(next);
  }
  function release() {
    clearTimeout(timer.current);
    clearInterval(waveTimer.current);
    media.current?.getTracks().forEach((t) => t.stop());
    media.current = null;
    const ctx = context.current;
    context.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
    setLevels(Array(32).fill(2));
    setQuiet(false);
  }
  function stop() {
    if (state.current === "requesting") {
      token.current++;
      release();
      changeState("off");
      return;
    }
    if (recorder.current?.state === "recording") {
      changeState("finishing");
      clearTimeout(timer.current);
      recorder.current.stop();
    }
  }
  async function transcribe(
    blob: Blob,
    id: string,
    time: number,
    version: number,
  ) {
    const controller = new AbortController();
    requests.current.set(id, controller);
    try {
      const wav = await wavFromBlob(blob);
      if (controller.signal.aborted || version !== epoch.current) return;
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav,
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok)
        throw Error(
          data.error || "음성 변환에 실패했습니다. 다시 녹음해주세요.",
        );
      if (version !== epoch.current || controller.signal.aborted) return;
      const segments: SpeechSegment[] = Array.isArray(data.segments)
        ? data.segments
        : [{ start: 0, end: 0, text: data.text }];
      const recognized = segments
        .map((s, i) => ({
          id: `${id}-${i}`,
          time: time + (Number.isFinite(s.start) ? s.start : 0),
          text: cleanTranscript(s.text),
        }))
        .filter((c) => c.text);
      // Replace only the pending row. Deleting it must never bring it back later.
      setClips((previous) =>
        previous.flatMap((c) => (c.id === id ? recognized : [c])),
      );
      if (!recognized.length)
        onError(
          "말소리가 충분히 잡히지 않았어요. 입력 장치와 마이크 거리를 확인하고 다시 녹음해주세요.",
        );
    } catch (e) {
      if (!controller.signal.aborted && version === epoch.current) {
        setClips((p) => p.filter((c) => c.id !== id));
        onError(
          e instanceof Error
            ? e.message
            : "음성을 변환하지 못했습니다. 다시 녹음해주세요.",
        );
      }
    } finally {
      requests.current.delete(id);
    }
  }
  async function start() {
    if (state.current !== "off" || requests.current.size) return;
    const current = ++token.current;
    changeState("requesting");
    onError("");
    setElapsed(0);
    setQuiet(false);
    let stream: MediaStream | null = null;
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw Error(
          "이 브라우저에서 녹음할 수 없습니다. Chrome 또는 Safari의 localhost에서 다시 시도해주세요.",
        );
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (current !== token.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      media.current = stream;
      setDevice(stream.getAudioTracks()[0]?.label || "기본 마이크");
      const ctx = new AudioContext();
      context.current = ctx;
      await ctx.resume();
      if (current !== token.current) {
        stream.getTracks().forEach((t) => t.stop());
        if (ctx.state !== "closed") void ctx.close().catch(() => {});
        return;
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount),
        samples = new Float32Array(analyser.fftSize);
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
        (m) => MediaRecorder.isTypeSupported(m),
      );
      const r = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: 128000,
      });
      recorder.current = r;
      const parts: Blob[] = [];
      const began = performance.now(),
        time = offset.current,
        version = epoch.current;
      let peak = 0;
      r.ondataavailable = (e) => {
        if (e.data.size) parts.push(e.data);
      };
      r.onstop = () => {
        const duration = (performance.now() - began) / 1000;
        const blob = new Blob(parts, { type: r.mimeType });
        parts.length = 0;
        // Finish the recorder first so its final audio packet is retained.
        release();
        recorder.current = null;
        if (version !== epoch.current) return;
        offset.current = time + duration;
        if (blob.size && duration >= 0.35) {
          const id = crypto.randomUUID();
          setClips((p) => [...p, { id, time, text: "", pending: true }]);
          void transcribe(blob, id, time, version);
        } else
          onError("녹음이 너무 짧아요. 한 문장 이상 말한 뒤 종료해주세요.");
        changeState("off");
      };
      r.onerror = () => {
        onError("녹음 장치 연결이 끊겼습니다. 입력 장치를 확인해주세요.");
        stop();
      };
      r.start();
      changeState("recording");
      waveTimer.current = setInterval(() => {
        analyser.getByteFrequencyData(bins);
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((sum, v) => sum + v * v, 0) / samples.length,
        );
        peak = Math.max(peak, rms);
        const seconds = (performance.now() - began) / 1000;
        setElapsed(Math.floor(seconds));
        setQuiet(seconds > 3 && peak < 0.005);
        setLevels(Array.from(bins.slice(0, 32), (v) => Math.max(2, v / 5)));
      }, 100);
      timer.current = setTimeout(stop, Math.max(1, Math.min(60, maxSeconds)) * 1000);
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      if (current !== token.current) return;
      release();
      changeState("off");
      onError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "마이크 권한이 거부되었습니다. 브라우저에서 마이크 사용을 허용해주세요."
          : e instanceof Error
            ? e.message
            : "마이크에 접근할 수 없습니다.",
      );
    }
  }
  function remove(id: string) {
    requests.current.get(id)?.abort();
    requests.current.delete(id);
    setClips((p) => p.filter((c) => c.id !== id));
  }
  function clear() {
    requests.current.forEach((c) => c.abort());
    requests.current.clear();
    setClips([]);
    offset.current = 0;
    onError("");
  }
  useEffect(
    () => () => {
      epoch.current++;
      token.current++;
      requests.current.forEach((c) => c.abort());
      clearTimeout(timer.current);
      clearInterval(waveTimer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      media.current?.getTracks().forEach((t) => t.stop());
      const ctx = context.current;
      if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
    },
    [],
  );
  const pending = clips.some((c) => c.pending);
  const text = clips
    .filter((c) => !c.pending)
    .map((c) => cleanTranscript(c.text))
    .filter(Boolean)
    .join("\n");
  return {
    clips,
    recording,
    levels,
    elapsed,
    quiet,
    device,
    pending,
    text,
    start,
    stop,
    remove,
    clear,
  };
}
