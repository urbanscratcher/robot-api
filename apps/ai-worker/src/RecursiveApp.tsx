import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Camera,
  Upload,
  Mic,
  Square,
  RotateCcw,
  Radio,
  X,
  Plus,
  ArrowUpRight,
  Trash2,
  Star,
  LoaderCircle,
  Eye,
  Hand,
  Sparkles,
  PlusCircle,
  ShieldCheck,
} from "lucide-react";
import {
  emptyIntervention,
  type Session,
  type Job,
  isActiveJob,
  type Generation,
  type Intervention,
  type Kind,
} from "./domain";
import { demoTranscript, makeDemoImage } from "./demo";
import { timecode, wavFromBlob } from "./media";
import {
  PipelineControls,
  ImageStage,
  ImageIntervention,
  type Mode,
} from "./ReproductionPanel";
import {
  ProductionStats,
  TransformationLog,
  originLabels,
} from "./TransformationLog";
import {
  GlassPanel,
  ConnectionSettings,
  GenerationTimeline,
  MobileDock,
} from "./GlassUI";
type Status = {
  textProvider?: string;
  modelName?: string;
  ollama: boolean;
  model: boolean;
  whisper: boolean;
  comfy: boolean;
  checkpoint: boolean;
  comfyCompatible: boolean;
  comfyError?: string;
  activeJob?: Job;
};
type Clip = {
  id: number;
  time: number;
  text: string;
  blob?: Blob;
  pending?: boolean;
};
const labels: Record<Kind, string> = {
  observation: "관찰",
  inference: "추론",
  fiction: "창작",
};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    `/api/${path}`,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "로컬 서버 요청 실패");
  return data;
}
export default function App() {
  const [mobileTab, setMobileTab] = useState<
    "observation" | "reproduction" | "story"
  >("observation");
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [status, setStatus] = useState<Status | null>(null),
    [checking, setChecking] = useState(false);
  const [image, setImage] = useState(""),
    [transcript, setTranscript] = useState(""),
    [demo, setDemo] = useState(false);
  const [generations, setGenerations] = useState<Generation[]>([]),
    [selected, setSelected] = useState(0),
    [edit, setEdit] = useState<Intervention>(emptyIntervention);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [consent, setConsent] = useState(false);
  const [camera, setCamera] = useState(false),
    [cameraReady, setCameraReady] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    cameraStream = useRef<MediaStream | null>(null),
    mediaEpoch = useRef(0),
    operation = useRef(false);
  const [recording, setRecording] = useState<
      "off" | "requesting" | "recording" | "gap"
    >("off"),
    [clips, setClips] = useState<Clip[]>([]),
    [levels, setLevels] = useState<number[]>(Array(32).fill(2));
  const micStream = useRef<MediaStream | null>(null),
    recorder = useRef<MediaRecorder | null>(null),
    recordOn = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    waveTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined),
    audioCtx = useRef<AudioContext | null>(null),
    started = useRef(0),
    audioEpoch = useRef(0),
    audioOffset = useRef(0),
    autoDelete = useRef(true);
  const [deleteAudio, setDeleteAudio] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null),
    [job, setJob] = useState<Job | null>(null),
    [mode, setMode] = useState<Mode>("manual"),
    [maxGenerations, setMaxGenerations] = useState(5),
    [reviewed, setReviewed] = useState<number[]>([]);
  const [archive, setArchive] = useState<
    { id: string; title: string; count: number; demo: boolean }[]
  >([]);
  const submitting = useRef(false),
    sessionRef = useRef<string | null>(null),
    seenGeneration = useRef(0),
    restoreEpoch = useRef(0);
  async function refreshArchive() {
    try {
      const result = await api<{ sessions: typeof archive }>("sessions");
      setArchive(result.sessions);
    } catch {
      /* Connection errors are reported by status checks. */
    }
  }
  function receiveSession(session: Session) {
    setGenerations(session.generations);
    setJob(session.job ?? null);
    const running = isActiveJob(session.job ?? null);
    if (!submitting.current) setBusy(running);
    setReviewed(session.reviewedGenerations ?? []);
    if (session.generations.length > seenGeneration.current) {
      seenGeneration.current = session.generations.length;
      setSelected(session.generations.at(-1)?.number ?? 0);
      setEdit(emptyIntervention());
      setNotice(
        `Generation ${session.generations.length} 기사와 이미지가 저장되었습니다.`,
      );
    }
    if (!running && !submitting.current) operation.current = false;
  }
  async function restoreSession(id: string) {
    const epoch = ++restoreEpoch.current;
    setError("");
    try {
      const session = await api<Session>(`sessions/${id}`);
      if (epoch !== restoreEpoch.current) return;
      stopCamera();
      stopRecording();
      audioEpoch.current++;
      setClips([]);
      setConsent(false);
      setSessionId(id);
      sessionRef.current = id;
      localStorage.setItem("overheard-session", id);
      setImage(session.original.image);
      setTranscript(session.original.transcript);
      setDemo(session.demo);
      seenGeneration.current = 0;
      setReviewed([]);
      setEdit(emptyIntervention());
      setSelected(0);
      receiveSession(session);
    } catch (e) {
      if (epoch === restoreEpoch.current)
        setError(e instanceof Error ? e.message : "세션 복원 실패");
    }
  }
  useEffect(() => {
    void refreshArchive();
    const id = localStorage.getItem("overheard-session");
    if (id) void restoreSession(id);
  }, []);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      let continuePolling = true;
      try {
        const session = await api<Session>(`sessions/${sessionId}`);
        if (cancelled) return;
        receiveSession(session);
        continuePolling = isActiveJob(session.job ?? null);
        if (!continuePolling) void refreshArchive();
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "생성 상태 조회 실패");
      }
      if (!cancelled && continuePolling) timeout = setTimeout(poll, 1500);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [sessionId, job?.id]);
  async function markReviewed(number: number) {
    if (!sessionId) return;
    try {
      const session = await api<Session>(`sessions/${sessionId}/review`, {
        generation: number,
        reviewed: !reviewed.includes(number),
      });
      setReviewed(session.reviewedGenerations ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "검토 기록 실패");
    }
  }
  async function stopProduction() {
    if (!sessionId) return;
    try {
      const result = await api<Job>(`sessions/${sessionId}/stop`, {});
      setJob(result);
      setNotice("중지 요청을 전달했습니다. 완료된 세대는 유지됩니다.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "중지 실패");
    }
  }
  async function replaceImage(file?: File) {
    if (!file) return;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 10 * 1024 * 1024
    ) {
      setError("10MB 이하 JPEG, PNG, WebP 이미지를 선택하세요.");
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const c = document.createElement("canvas");
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      c.width = bitmap.width * scale;
      c.height = bitmap.height * scale;
      c.getContext("2d")!.drawImage(bitmap, 0, 0, c.width, c.height);
      bitmap.close();
      setEdit((p) => ({
        ...p,
        replacementImage: c.toDataURL("image/jpeg", 0.85),
      }));
    } catch {
      setError("교체 이미지를 읽지 못했습니다.");
    }
  }

  const latest = generations.at(-1),
    active = generations.find((g) => g.number === selected);
  const locked = busy || !!sessionId,
    pending = clips.some((c) => c.pending);
  async function check() {
    setChecking(true);
    try {
      setStatus(await api<Status>("status"));
    } catch {
      setStatus(null);
      setNotice("로컬 API 연결 실패. npm run dev 실행을 확인하세요.");
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void check();
    return () => {
      mediaEpoch.current++;
      audioEpoch.current++;
      recordOn.current = false;
      clearTimeout(timer.current);
      clearInterval(waveTimer.current);
      cameraStream.current?.getTracks().forEach((t) => t.stop());
      micStream.current?.getTracks().forEach((t) => t.stop());
      if (recorder.current?.state === "recording") recorder.current.stop();
      void audioCtx.current?.close();
    };
  }, []);
  function stopCamera() {
    mediaEpoch.current++;
    cameraStream.current?.getTracks().forEach((t) => t.stop());
    cameraStream.current = null;
    setCamera(false);
    setCameraReady(false);
  }
  async function openCamera() {
    const epoch = ++mediaEpoch.current;
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 } },
        audio: false,
      });
      if (epoch !== mediaEpoch.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      cameraStream.current = stream;
      setCamera(true);
      setTimeout(() => {
        if (video.current) video.current.srcObject = stream;
      }, 0);
    } catch {
      setError(
        "웹캠에 접근할 수 없습니다. 권한을 허용하거나 사진을 업로드하세요.",
      );
    }
  }
  function snap() {
    if (!video.current?.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = video.current.videoWidth;
    c.height = video.current.videoHeight;
    c.getContext("2d")!.drawImage(video.current, 0, 0);
    setImage(c.toDataURL("image/jpeg", 0.85));
    stopCamera();
  }
  async function upload(file?: File) {
    if (!file) return;
    setError("");
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 10 * 1024 * 1024
    ) {
      setError("10MB 이하의 JPEG, PNG, WebP 사진을 선택하세요.");
      return;
    }
    const epoch = ++mediaEpoch.current;
    try {
      const bitmap = await createImageBitmap(file);
      const c = document.createElement("canvas");
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      c.width = bitmap.width * scale;
      c.height = bitmap.height * scale;
      c.getContext("2d")!.drawImage(bitmap, 0, 0, c.width, c.height);
      bitmap.close();
      if (epoch !== mediaEpoch.current) return;
      setImage(c.toDataURL("image/jpeg", 0.85));
      cameraStream.current?.getTracks().forEach((t) => t.stop());
      setCamera(false);
      setCameraReady(false);
    } catch {
      setError("이미지를 읽을 수 없습니다. 다른 파일을 선택하세요.");
    }
  }
  function stopRecording() {
    if (recordOn.current && started.current)
      audioOffset.current = (Date.now() - started.current) / 1000;
    recordOn.current = false;
    clearTimeout(timer.current);
    clearInterval(waveTimer.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
    micStream.current?.getTracks().forEach((t) => t.stop());
    micStream.current = null;
    void audioCtx.current?.close();
    audioCtx.current = null;
    setRecording("off");
    setLevels(Array(32).fill(2));
  }
  async function startRecording() {
    if (!consent || recordOn.current) return;
    recordOn.current = true;
    const epoch = ++audioEpoch.current;
    setRecording("requesting");
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!recordOn.current || epoch !== audioEpoch.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      micStream.current = stream;
      started.current = Date.now() - audioOffset.current * 1000;
      const context = new AudioContext();
      audioCtx.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 128;
      context.createMediaStreamSource(stream).connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      waveTimer.current = setInterval(() => {
        analyser.getByteFrequencyData(bins);
        setLevels(
          recordOn.current && recorder.current?.state === "recording"
            ? Array.from(bins.slice(0, 32), (v) => Math.max(2, v / 5))
            : Array(32).fill(2),
        );
      }, 100);
      function segment() {
        if (!recordOn.current || epoch !== audioEpoch.current) return;
        stream.getAudioTracks().forEach((t) => (t.enabled = true));
        setRecording("recording");
        const r = new MediaRecorder(stream);
        recorder.current = r;
        const parts: Blob[] = [];
        const start = (Date.now() - started.current) / 1000;
        const id = Date.now();
        r.ondataavailable = (e) => {
          if (e.data.size) parts.push(e.data);
        };
        r.onstop = () => {
          const blob = new Blob(parts, { type: r.mimeType });
          if (epoch === audioEpoch.current) {
            setClips((p) => [
              ...p,
              { id, time: start, text: "전사 중…", blob, pending: true },
            ]);
            void transcribe(blob, id, epoch);
          }
          if (recordOn.current && epoch === audioEpoch.current) {
            stream.getAudioTracks().forEach((t) => (t.enabled = false));
            setRecording("gap");
            setClips((p) => [
              ...p,
              {
                id: id + 1,
                time: (Date.now() - started.current) / 1000,
                text: "[기록되지 않음]",
              },
            ]);
            timer.current = setTimeout(segment, 3000);
          }
        };
        r.start();
        timer.current = setTimeout(() => {
          if (r.state === "recording") r.stop();
        }, 4000);
      }
      segment();
    } catch {
      stopRecording();
      setError(
        "마이크를 열 수 없습니다. 권한을 확인하거나 녹취를 직접 입력하세요.",
      );
    }
  }
  async function transcribe(blob: Blob, id: number, epoch: number) {
    try {
      const wav = await wavFromBlob(blob);
      const r = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav,
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      if (epoch !== audioEpoch.current) return;
      setClips((p) =>
        p.map((c) =>
          c.id === id
            ? {
                ...c,
                text: data.text || "[음성 인식 없음]",
                pending: false,
                blob: autoDelete.current ? undefined : blob,
              }
            : c,
        ),
      );
    } catch (e) {
      if (epoch !== audioEpoch.current) return;
      setClips((p) =>
        p.map((c) =>
          c.id === id
            ? { ...c, text: "[전사 실패 · 직접 입력 필요]", pending: false }
            : c,
        ),
      );
      setError(e instanceof Error ? e.message : "전사 실패");
    }
  }
  const combined = [
    transcript.trim(),
    ...clips.map((c) => `[${timecode(c.time)}] ${c.text}`),
  ]
    .filter(Boolean)
    .join("\n");
  async function generate() {
    if (operation.current || busy || !consent) return;
    operation.current = true;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      let id = sessionRef.current;
      if (!id) {
        const session = await api<Session>("sessions", {
          image,
          transcript: combined,
          demo,
        });
        id = session.id;
        sessionRef.current = id;
        seenGeneration.current = 0;
        setSessionId(id);
        localStorage.setItem("overheard-session", id);
      }
      const result = await api<Job>(`sessions/${id}/run`, {
        mode,
        maxGenerations,
        intervention: edit,
      });
      setJob(result);
      setBusy(true);
      submitting.current = false;
      void refreshArchive();
    } catch (e) {
      submitting.current = false;
      operation.current = false;
      setBusy(false);
      setError(e instanceof Error ? e.message : "생성 실패");
    }
  }
  function reset() {
    if (busy) return;
    setMobileTab("observation");
    stopCamera();
    stopRecording();
    audioEpoch.current++;
    audioOffset.current = 0;
    started.current = 0;
    restoreEpoch.current++;
    sessionRef.current = null;
    setSessionId(null);
    localStorage.removeItem("overheard-session");
    setJob(null);
    seenGeneration.current = 0;
    setReviewed([]);
    setMode("manual");
    setMaxGenerations(5);
    setGenerations([]);
    setSelected(0);
    setImage("");
    setTranscript("");
    setClips([]);
    setDemo(false);
    setEdit(emptyIntervention());
    setError("");
    setNotice("새 관찰을 시작합니다. 이전 결과는 로컬 보관함에 남아 있습니다.");
  }
  function loadDemo() {
    reset();
    setImage(makeDemoImage());
    setTranscript(demoTranscript);
    setDemo(true);
    setNotice(
      "DEMO 모드: 합성 이미지와 사전 작성된 기사로 체험합니다. Ollama를 호출하지 않습니다.",
    );
  }
  function toggle(field: "deleted" | "emphasized", id: string) {
    setEdit((p) => ({
      ...p,
      [field]: p[field].includes(id)
        ? p[field].filter((x) => x !== id)
        : [...p[field], id],
    }));
  }
  const canReproduce =
    !!image &&
    !!combined.trim() &&
    consent &&
    recording === "off" &&
    !pending &&
    (demo ||
      (!!status?.model && !!status?.checkpoint && !!status?.comfyCompatible)) &&
    generations.length < 30 &&
    (mode !== "auto" || maxGenerations > generations.length);
  const reproductionHint = !image
    ? "사진을 먼저 추가해주세요"
    : !combined.trim()
      ? "대화의 조각을 입력해주세요"
      : !consent
        ? "참여자 동의를 확인해주세요"
        : recording !== "off"
          ? "녹음을 마치고 이어갈 수 있어요"
          : pending
            ? "녹취를 변환하고 있어요"
            : generations.length >= 30
              ? "최대 30세대에 도달했어요"
              : mode === "auto" && maxGenerations <= generations.length
                ? "최대 세대를 현재보다 크게 설정해주세요"
                : !demo &&
                    (!status?.model ||
                      !status?.checkpoint ||
                      !status?.comfyCompatible)
                  ? "로컬 AI 연결을 확인해주세요"
                  : "";
  function chooseTab(tab: typeof mobileTab) {
    setMobileTab(tab);
    if (isMobile)
      requestAnimationFrame(() =>
        document
          .getElementById(`${tab}-panel`)
          ?.scrollIntoView({ block: "start" }),
      );
  }
  function reproduce() {
    chooseTab("reproduction");
    void generate();
  }
  function selectGeneration(n: number) {
    setSelected(n);
  }
  function focusReadiness() {
    const adjustLimit = reproductionHint.includes("최대 세대");
    setMobileTab(adjustLimit ? "reproduction" : "observation");
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        adjustLimit
          ? 'input[aria-label="최대 세대 수"]'
          : !image
            ? ".source-actions input"
            : !combined.trim()
              ? "#transcript"
              : !consent
                ? ".consent input"
                : ".source-bottom",
      );
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    });
  }
  const controls = (
    <PipelineControls
      mode={mode}
      setMode={setMode}
      max={maxGenerations}
      setMax={setMaxGenerations}
      job={job}
      busy={busy}
      count={generations.length}
      ready={canReproduce}
      hint={reproductionHint}
      onGenerate={reproduce}
      onStop={stopProduction}
    />
  );
  return (
    <div className="app-shell" data-mobile-tab={mobileTab}>
      <header className="topbar">
        <a href="./" className="wordmark">
          <span className="brand-symbol">
            <Eye size={23} strokeWidth={1.7} />
          </span>
          <span className="brand-copy">
            <strong>THE OVERHEARD</strong>
            <small>A Machine That Makes Stories</small>
          </span>
        </a>
        <div className="system">
          <span
            className={`connection-chip ${status?.model ? "connected" : ""}`}
          >
            <span className="dot" />
            Ollama{" "}
            <small>
              {checking || !status
                ? "확인 중"
                : status.model
                  ? "Connected"
                  : "Offline"}
            </small>
          </span>
          <span
            className={`connection-chip ${status?.checkpoint && status?.comfyCompatible ? "connected" : ""}`}
          >
            <span className="dot" />
            ComfyUI{" "}
            <small>
              {checking || !status
                ? "확인 중"
                : status.checkpoint && status.comfyCompatible
                  ? "Connected"
                  : "Offline"}
            </small>
          </span>
          <span className="header-generation">
            GEN {String(selected).padStart(2, "0")}
          </span>
          {recording !== "off" && (
            <button className="recording-status" onClick={stopRecording}>
              <span className="record-indicator recording" />
              REC · 종료
            </button>
          )}
          <ConnectionSettings
            status={status}
            checking={checking}
            onCheck={check}
          />
        </div>
      </header>
      <main>
        <section className="intro">
          <div>
            <h1>
              작은 단서, <span>끝없는 이야기.</span>
            </h1>
            <p>사진과 대화 한 조각을 건네주세요. 나머지는 기계가 상상합니다.</p>
          </div>
          <button
            className="demo-button"
            disabled={busy || recording !== "off"}
            onClick={loadDemo}
          >
            <Sparkles size={16} />
            데모로 체험하기
            <ArrowUpRight size={15} />
          </button>
        </section>
        <div className="archive-bar">
          <label>
            <span className="archive-label">이 기기의 이야기</span>{" "}
            <select
              aria-label="로컬 보관함"
              disabled={busy || recording !== "off" || camera}
              value={sessionId ?? ""}
              onChange={(e) => {
                if (e.target.value) void restoreSession(e.target.value);
              }}
            >
              <option value="">새 관찰</option>
              {archive.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.demo ? "DEMO · " : ""}
                  {a.count}세대 · {a.title}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy || recording !== "off"} onClick={reset}>
            <PlusCircle size={16} />새 관찰 시작
          </button>
          <span className="local-note">
            <ShieldCheck size={14} />
            원본과 이야기는 이 기기에만 보관됩니다.
          </span>
        </div>
        <nav className="mobile-tabs" role="tablist" aria-label="작업 영역">
          {(["observation", "reproduction", "story"] as const).map(
            (tab, index) => (
              <button
                key={tab}
                id={`tab-${tab}`}
                role="tab"
                aria-selected={mobileTab === tab}
                aria-controls={`${tab}-panel`}
                tabIndex={mobileTab === tab ? 0 : -1}
                onClick={() => chooseTab(tab)}
                onKeyDown={(e) => {
                  if (
                    e.key === "ArrowRight" ||
                    e.key === "ArrowLeft" ||
                    e.key === "Home" ||
                    e.key === "End"
                  ) {
                    e.preventDefault();
                    const tabs = [
                      "observation",
                      "reproduction",
                      "story",
                    ] as const;
                    const next =
                      e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? 2
                          : (index + (e.key === "ArrowRight" ? 1 : 2)) % 3;
                    chooseTab(tabs[next]);
                    document.getElementById(`tab-${tabs[next]}`)?.focus();
                  }
                }}
              >
                {tab === "observation"
                  ? "Observation"
                  : tab === "reproduction"
                    ? "Reproduction"
                    : "The Story"}
              </button>
            ),
          )}
        </nav>
        <div className="workspace">
          <GlassPanel
            as="aside"
            className="evidence"
            id="observation-panel"
            hidden={isMobile && mobileTab !== "observation"}
            role={isMobile ? "tabpanel" : "region"}
            aria-label="Observation"
            aria-labelledby={isMobile ? "tab-observation" : undefined}
          >
            <section className="source-block">
              <div className="section-top">
                <h2>
                  <span className="panel-symbol">
                    <Camera size={18} />
                  </span>{" "}
                  Observation
                </h2>
                <span className="panel-meta">GEN 00 · 원본</span>
              </div>
              <div className={`viewfinder ${image ? "has-image" : ""}`}>
                {camera ? (
                  <video
                    ref={video}
                    autoPlay
                    muted
                    playsInline
                    onLoadedData={() => setCameraReady(true)}
                  />
                ) : image ? (
                  <img
                    src={image}
                    alt={
                      demo
                        ? "데모용 합성 장면: 창가에 앉아 있는 두 실루엣"
                        : "관객이 제공한 원본 사진"
                    }
                  />
                ) : (
                  <div className="image-empty">
                    <Camera size={32} strokeWidth={1} />
                    <p>어떤 장면을 남겨볼까요?</p>
                    <span>사진을 업로드하거나 직접 촬영하세요.</span>
                  </div>
                )}
                <div className="cam-meta">
                  <span>
                    ORIGINAL /{" "}
                    {demo
                      ? "SYNTHETIC"
                      : image
                        ? "CAPTURED"
                        : camera
                          ? "LIVE"
                          : "STANDBY"}
                  </span>
                  <span className="cross">+</span>
                </div>
                <div className="frame-bottom">
                  <span>{image ? "EVIDENCE #001" : "NO SIGNAL"}</span>
                  <span>LOCAL ONLY</span>
                </div>
              </div>
              <div className="source-actions">
                <label className={`button ${locked || demo ? "disabled" : ""}`}>
                  <Upload size={14} />
                  이미지 업로드
                  <input
                    aria-label="이미지 업로드"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={locked || demo}
                    onChange={(e) => {
                      void upload(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                {camera ? (
                  <>
                    <button disabled={!cameraReady || locked} onClick={snap}>
                      촬영
                    </button>
                    <button onClick={stopCamera} aria-label="카메라 끄기">
                      <X size={15} />
                    </button>
                  </>
                ) : (
                  <button
                    disabled={locked || demo || !consent}
                    onClick={openCamera}
                  >
                    <Camera size={14} />
                    웹캠
                  </button>
                )}
              </div>
              <p className="hint">JPEG / PNG / WEBP · 최대 10MB</p>
            </section>
            {generations[0] && (
              <details className="original-facts">
                <summary>원본 관찰 근거 · AI 분류</summary>
                <p className="hint">
                  모델이 원본에서 관찰했다고 분류한 문장입니다. 직접 사실 검증한
                  결과는 아닙니다.
                </p>
                {generations[0].article.body
                  .filter((c) => c.kind === "observation")
                  .map((c) => (
                    <p key={c.id}>{c.text}</p>
                  ))}
              </details>
            )}
            <section className="source-block">
              <div className="section-top">
                <h2>
                  <span className="panel-symbol">
                    <Mic size={17} />
                  </span>{" "}
                  대화의 조각
                </h2>
                <span className="panel-meta">부분 기록</span>
              </div>
              <div className="audio-strip">
                <div
                  className={`record-indicator ${recording === "recording" ? "recording" : ""}`}
                />
                <span aria-live="polite">
                  {recording === "recording"
                    ? "REC · 4초 기록 중"
                    : recording === "gap"
                      ? "GAP · 3초 기록하지 않음"
                      : recording === "requesting"
                        ? "마이크 권한 확인 중"
                        : "마이크 대기 중"}
                </span>
                <span className="audio-wave" aria-hidden="true">
                  {levels.map((v, i) => (
                    <i
                      key={i}
                      style={{ transform: `scaleY(${Math.max(0.08, v / 40)})` }}
                    />
                  ))}
                </span>
              </div>
              <div className="record-actions">
                {recording === "off" ? (
                  <button
                    disabled={!consent || locked || demo || !status?.whisper}
                    onClick={startRecording}
                  >
                    <Mic size={14} />
                    부분 녹음 시작
                  </button>
                ) : (
                  <button className="red-outline" onClick={stopRecording}>
                    <Square size={12} />
                    녹음 종료
                  </button>
                )}
                <span>4초 기록 / 3초 공백</span>
              </div>
              {status && !status.whisper && (
                <p className="hint">
                  Whisper 미연결 · 아래에 녹취를 직접 입력하세요.
                </p>
              )}
              <label className="field-label" htmlFor="transcript">
                부분 녹취 <span>직접 편집 가능</span>
              </label>
              <textarea
                id="transcript"
                value={transcript}
                disabled={locked || demo}
                maxLength={12000}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder={
                  "[00:03] “아까 그 사람 봤어?”\n[00:08] [기록되지 않음]\n[00:14] “그건 절대 말하면 안 돼.”"
                }
                rows={6}
              />
              {clips.length > 0 && (
                <div className="clips">
                  {clips.map((c) => (
                    <div key={c.id}>
                      <time>{timecode(c.time)}</time>
                      <input
                        aria-label={`${timecode(c.time)} 녹취`}
                        value={c.text}
                        disabled={locked || c.pending}
                        onChange={(e) =>
                          setClips((p) =>
                            p.map((x) =>
                              x.id === c.id
                                ? { ...x, text: e.target.value }
                                : x,
                            ),
                          )
                        }
                      />
                      {c.blob && (
                        <button
                          disabled={locked}
                          onClick={() =>
                            setClips((p) =>
                              p.map((x) =>
                                x.id === c.id ? { ...x, blob: undefined } : x,
                              ),
                            )
                          }
                          aria-label="원본 오디오 삭제"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={deleteAudio}
                  onChange={(e) => {
                    setDeleteAudio(e.target.checked);
                    autoDelete.current = e.target.checked;
                  }}
                />
                전사 성공 후 원본 오디오 자동 삭제
              </label>
              {clips.some((c) => c.blob) && (
                <button
                  className="text-button"
                  onClick={() =>
                    setClips((p) => p.map((c) => ({ ...c, blob: undefined })))
                  }
                >
                  <Trash2 size={12} />
                  보관된 오디오 모두 삭제
                </button>
              )}
            </section>
            <div className="source-bottom">
              <label className="check-label consent">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={recording !== "off" || camera || busy}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                사진·대화의 저장과 AI 재구성{status?.textProvider === "claude" ? " 및 Claude API 전송" : ""}에 참여자 모두가 동의했습니다.
              </label>
              <p className="hint">
                {demo
                  ? "DEMO · 사전 작성된 허구적 기사"
                  : !status
                    ? "로컬 API 대기 · npm run dev를 확인하세요."
                    : !status.ollama
                      ? "Ollama 미연결 · ollama serve를 실행하세요."
                      : !status.model
                        ? (status.textProvider === "claude" ? "Claude API 키를 설정하세요." : "모델 미설치 · ollama pull gemma3:4b")
                        : !status.comfy ||
                            !status.checkpoint ||
                            !status.comfyCompatible
                          ? (status.comfyError ??
                            "ComfyUI 또는 SDXL 체크포인트를 확인하세요.")
                          : `${status.modelName || "gemma3:4b"} → SDXL · 순차 생성`}
              </p>
            </div>
          </GlassPanel>
          <ImageStage
            original={image}
            active={active}
            generations={generations}
            selected={selected}
            onSelect={selectGeneration}
            busy={busy}
            job={job}
            hidden={isMobile && mobileTab !== "reproduction"}
            tabbed={isMobile}
          >
            {controls}
          </ImageStage>
          <GlassPanel
            className="output"
            id="story-panel"
            hidden={isMobile && mobileTab !== "story"}
            role={isMobile ? "tabpanel" : "region"}
            aria-label="The Story"
            aria-labelledby={isMobile ? "tab-story" : undefined}
          >
            <div className="section-top">
              <h2>
                <span className="panel-symbol story-symbol">
                  <Radio size={18} />
                </span>{" "}
                The Story
              </h2>
              <span className="fiction-label">
                AI-generated fictional reconstruction
              </span>
            </div>
            {busy && (
              <div className="loading" role="status">
                <LoaderCircle className="spin" size={16} />{" "}
                {demo
                  ? "데모 기사 구성 중"
                  : "새 이야기를 만드는 중입니다. 이전 기사는 그대로 남아 있습니다."}
              </div>
            )}
            {active ? (
              <div className="article-area">
                <div className="article-dateline">
                  <span>
                    THE OVERHEARD / GENERATION{" "}
                    {active.number.toString().padStart(2, "0")}
                  </span>
                  <b>
                    {active.demo ? "DEMO / 사전 작성" : "LOCAL AI / 미검증"}
                  </b>
                </div>
                <h2 className="headline">{active.article.title}</h2>
                <p className="summary">{active.article.summary}</p>
                <div className="byline">
                  취재·작성 THE OVERHEARD AI{" "}
                  <span>사진과 녹취의 관계는 확인되지 않았습니다.</span>
                </div>
                <p className="image-caption">
                  {active.number === 1
                    ? "원본 사진과 부분 녹취로 시작한 허구적 AI 재구성물."
                    : "직전 AI 이미지와 기사로 재생산된 허구적 재구성물. 원본은 입력되지 않았습니다."}
                </p>
                <button
                  className="review-button"
                  aria-pressed={reviewed.includes(active.number)}
                  onClick={() => markReviewed(active.number)}
                >
                  {reviewed.includes(active.number)
                    ? "검토 완료 표시됨"
                    : "이 세대 검토 완료로 표시"}
                </button>
                <div className="legend">
                  {Object.entries(labels).map(([k, v]) => (
                    <span key={k}>
                      <i className={k} />
                      {v}
                    </span>
                  ))}
                  <span>문장을 편집해 다음 보도에 개입하세요.</span>
                </div>
                <div className="article-body" aria-label="기사 본문">
                  {active.article.body.map((c) => (
                    <div
                      className={`claim ${c.origin === "HUMAN_INTERVENTION" ? "human-edited" : ""} ${edit.deleted.includes(c.id) && selected === latest?.number ? "deleted" : ""} ${edit.emphasized.includes(c.id) && selected === latest?.number ? "emphasized" : ""}`}
                      key={c.id}
                    >
                      <div className={`claim-kind ${c.kind}`}>
                        {labels[c.kind]}
                        <small>
                          G{c.firstGeneration} 최초
                          {c.semanticMatch ? " · 추정" : ""}
                        </small>
                      </div>
                      <div>
                        <p>{c.text}</p>
                        {c.origin && (
                          <small className="claim-origin">
                            {originLabels[c.origin]}
                          </small>
                        )}
                        {c.sourceIds.length > 0 && (
                          <small className="source-ref">
                            AI가 연결한 출처: {c.sourceIds.join(", ")}
                          </small>
                        )}
                      </div>
                      {active.number === latest?.number && (
                        <div className="claim-actions">
                          <button
                            disabled={busy}
                            aria-label="문장 강조"
                            aria-pressed={edit.emphasized.includes(c.id)}
                            onClick={() => toggle("emphasized", c.id)}
                          >
                            <Star size={13} />
                          </button>
                          <button
                            disabled={busy}
                            aria-label="문장 삭제 또는 복원"
                            aria-pressed={edit.deleted.includes(c.id)}
                            onClick={() => toggle("deleted", c.id)}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {active.article.quotes.length > 0 && (
                  <blockquote>
                    <span>OVERHEARD / 대화 발췌</span>
                    {active.article.quotes.map((q, i) => (
                      <p key={i}>“{q}”</p>
                    ))}
                  </blockquote>
                )}
                <div className="interpretation">
                  <h3>AI가 추론한 상황</h3>
                  <p>{active.article.situation}</p>
                  <h3>다르게 읽는 두 가지 방법</h3>
                  {active.article.alternatives.map((s, i) => (
                    <p key={i}>
                      <b>0{i + 1}</b>
                      {s}
                    </p>
                  ))}
                </div>
              </div>
            ) : selected === 0 && generations.length > 0 ? (
              <div className="original-view">
                <span className="eyebrow">GENERATION 00 / 원본 기록</span>
                <h2>서사가 되기 전.</h2>
                <img src={image} alt="최초 원본 사진" />
                <pre>{combined}</pre>
                <p className="hint">
                  원본은 최초 보도에만 전달됩니다. 다음 세대는 직전 AI
                  이미지·기사와 인간의 개입을 입력받습니다.
                </p>
              </div>
            ) : (
              <div className="output-empty">
                <div className="empty-index">
                  <Radio size={30} strokeWidth={1.5} />
                </div>
                <span className="empty-story-label">
                  아직 쓰이지 않은 이야기
                </span>
                <h2>
                  당신의 장면이
                  <br />
                  이야기가 될 거예요.
                </h2>
                <p>
                  한 장의 사진과 몇 마디의 대화를 건네주세요.
                  <br />
                  AI는 그 사이의 공백에서 이야기를 찾습니다.
                </p>
                <div className="empty-flow">
                  <span>관찰된 장면</span>
                  <ArrowRight size={14} />
                  <span>과잉 해석</span>
                  <ArrowRight size={14} />
                  <span>가상의 사건</span>
                </div>
              </div>
            )}
            {latest && (
              <details
                className="intervention"
                open={mode === "human" ? true : undefined}
              >
                <summary className="intervention-heading">
                  <span>
                    <Hand size={17} />이 이야기에 손대기
                  </span>
                  <small>Human-in-the-loop</small>
                  <Plus size={15} />
                </summary>
                <div className="intervention-content">
                  {selected !== latest.number ? (
                    <button
                      className="text-button"
                      onClick={() => setSelected(latest.number)}
                    >
                      최신 세대에서 다음 보도 편집하기 <ArrowRight size={14} />
                    </button>
                  ) : (
                    <>
                      <p>
                        문장의 ×로 삭제하고 ☆로 강조하세요. 원본 기사는
                        보존됩니다.
                      </p>
                      <label className="field-label" htmlFor="insert">
                        <Plus size={12} />
                        문장 삽입
                      </label>
                      <textarea
                        id="insert"
                        rows={2}
                        maxLength={2000}
                        value={edit.inserted}
                        disabled={busy}
                        onChange={(e) =>
                          setEdit((p) => ({ ...p, inserted: e.target.value }))
                        }
                        placeholder="새로운 단서를 끼워 넣어보세요. 이 문장도 미검증 자료로 전달됩니다."
                      />
                      <label className="field-label" htmlFor="direction">
                        다음 보도 방향
                      </label>
                      <input
                        id="direction"
                        className="direction"
                        maxLength={1000}
                        value={edit.direction}
                        disabled={busy}
                        onChange={(e) =>
                          setEdit((p) => ({ ...p, direction: e.target.value }))
                        }
                        placeholder="예: 음모 대신 평범한 일상의 가능성에 집중해줘"
                      />
                      <ImageIntervention
                        currentPrompt={latest.imagePrompt}
                        edit={edit}
                        setEdit={setEdit}
                        busy={busy}
                        onUpload={replaceImage}
                      />
                      <button
                        className="button editor-generate"
                        disabled={busy || !canReproduce}
                        onClick={reproduce}
                      >
                        <Hand size={16} />
                        편집을 반영해 다시 만들기
                        <ArrowUpRight size={15} />
                      </button>
                      <p className="hint">
                        직전 AI 이미지 + 편집된 기사 + 당신의 개입 → 다음 기사와
                        이미지. 원본 증거는 다시 전달하지 않습니다.
                      </p>
                    </>
                  )}
                </div>
              </details>
            )}
          </GlassPanel>
        </div>
        <GenerationTimeline
          image={image}
          generations={generations}
          selected={selected}
          onSelect={selectGeneration}
        />
        {generations.length > 0 && (
          <>
            <ProductionStats generations={generations} reviewed={reviewed} />
            <TransformationLog
              generation={active}
              previous={generations.find(
                (g) => g.number === (active?.number ?? 0) - 1,
              )}
            />
          </>
        )}
        {generations.length > 0 && (
          <details className="comparison glass-panel">
            <summary className="comparison-title">
              세대별 기사를 나란히 읽기<span>Generation archive</span>
              <Plus size={17} />
            </summary>
            <div className="comparison-content">
              <div className="section-top">
                <h2>서사는 어떻게 멀어지는가.</h2>
                <span>GENERATION ARCHIVE / 가로로 비교</span>
              </div>
              <p className="hint">
                주장의 계승·삭제와 이미지 변화는 AI의 의미 비교 추정입니다.
                계승된 AI 주장은 원본 사실로 승격되지 않습니다. 각 문장의 부모
                ID와 최초 등장 세대를 함께 확인하세요.
              </p>
              <div className="compare-scroll">
                <article>
                  <span className="eyebrow">GEN 00 / ORIGINAL</span>
                  <img src={image} alt="원본 기록" />
                  <pre>{combined}</pre>
                </article>
                {generations.map((g) => (
                  <article key={g.number}>
                    <button
                      className="text-button"
                      onClick={() => setSelected(g.number)}
                    >
                      GEN {String(g.number).padStart(2, "0")} /{" "}
                      {g.demo ? "DEMO" : "AI"} <ArrowUpRight size={13} />
                    </button>
                    {g.generatedImage && (
                      <figure className="archive-image">
                        <img
                          src={g.generatedImage}
                          alt={`G${g.number} ${g.demo ? "데모" : "AI 생성"} 이미지`}
                        />
                        <figcaption>
                          {g.demo
                            ? "DEMO / 합성 시뮬레이션"
                            : "AI GENERATED / 원본 아님"}{" "}
                          · {((g.generationDuration ?? 0) / 1000).toFixed(1)}s
                        </figcaption>
                      </figure>
                    )}
                    <h3>{g.article.title}</h3>
                    {g.article.body.map((c) => (
                      <p key={c.id} className={c.kind}>
                        <span className="compare-tag">
                          {labels[c.kind]} · G{c.firstGeneration} 최초
                        </span>
                        {c.text}
                      </p>
                    ))}
                    {g.number > 1 && (
                      <details>
                        <summary>이 세대에 반영한 인간 개입</summary>
                        <pre>{JSON.stringify(g.intervention, null, 2)}</pre>
                      </details>
                    )}
                  </article>
                ))}
              </div>
            </div>
          </details>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
            <button aria-label="오류 닫기" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        <div className="session-status" role="status">
          {notice || "관찰 대기 중. 어떤 자료도 자동으로 수집하지 않습니다."}
        </div>
        <footer>
          <span>
            THE OVERHEARD <small>기록은 불완전하다. 보도는 완성된다.</small>
          </span>
          <button disabled={busy} onClick={reset}>
            <Trash2 size={13} />새 관찰 시작
          </button>
          <span>NO CLOUD. NO TRUTH GUARANTEED.</span>
        </footer>
      </main>
      <MobileDock
        busy={busy}
        ready={canReproduce}
        job={job}
        count={generations.length}
        mode={mode}
        onGenerate={reproduce}
        onStop={stopProduction}
        hint={reproductionHint}
        onHint={focusReadiness}
      />
    </div>
  );
}
