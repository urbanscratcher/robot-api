import { ClaudeToggle } from './ClaudeToggle';
import { useEffect, useRef, useState } from "react";
import {
  Camera,
  Upload,
  Mic,
  Square,
  ArrowRight,
  Eye,
  RotateCcw,
  Sparkles,
  Trash2,
  LoaderCircle,
  X,
} from "lucide-react";
import { GlassPanel } from "./GlassUI";
import type { Article } from "./domain";
import { makeDemoImage } from "./demo";
import { timecode } from "./media";
import { useConversation } from "./useConversation";
type Status = { textProvider?: string; ollama: boolean; model: boolean; whisper: boolean };
export default function App() {
  const [image, setImage] = useState("");
  const [article, setArticle] = useState<Article | null>(null),
    [articleImage, setArticleImage] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [consent, setConsent] = useState(false),
    [status, setStatus] = useState<Status | null>(null),
    [checking, setChecking] = useState(false);
  const [camera, setCamera] = useState(false),
    [cameraReady, setCameraReady] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    cameraStream = useRef<MediaStream | null>(null),
    mediaEpoch = useRef(0),
    request = useRef<AbortController | null>(null),
    operation = useRef(false);
  const conversation = useConversation(setError);
  const { clips, recording, levels, pending, text: combined } = conversation;
  async function check() {
    setChecking(true);
    try {
      const r = await fetch("/api/status");
      if (!r.ok) throw Error();
      setStatus(await r.json());
    } catch {
      setStatus(null);
      setError(
        "로컬 서버에 연결할 수 없습니다. npm run dev 실행을 확인해주세요.",
      );
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void check();
    return () => {
      mediaEpoch.current++;

      cameraStream.current?.getTracks().forEach((t) => t.stop());

      request.current?.abort();
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
  async function generate() {
    if (
      operation.current ||
      !image ||
      !combined.trim() ||
      !consent ||
      pending ||
      recording !== "off"
    )
      return;
    operation.current = true;
    setBusy(true);
    setError("");
    stopCamera();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ image, transcript: combined, generation: 1 }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "기사를 만들지 못했습니다.");
      setArticle(data.article);
      setArticleImage(image);
      if (window.matchMedia("(max-width:760px)").matches)
        requestAnimationFrame(() =>
          document.querySelector(".simple-story")?.scrollIntoView({
            block: "start",
            behavior: window.matchMedia("(prefers-reduced-motion:reduce)")
              .matches
              ? "auto"
              : "smooth",
          }),
        );
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "기사 생성 실패");
    } finally {
      operation.current = false;
      setBusy(false);
      request.current = null;
    }
  }
  function example() {
    stopCamera();

    setImage(makeDemoImage());
    setArticle(null);
    setError("");
  }
  const ready =
    !!image &&
    !!combined.trim() &&
    consent &&
    !pending &&
    recording === "off" &&
    !!status?.model;
  return (
    <div className="simple-shell">
      <header className="simple-header">
        <a href="./" className="wordmark">
          <span className="brand-symbol">
            <Eye size={23} />
          </span>
          <span className="brand-copy">
            <strong>THE OVERHEARD</strong>
            <small>사진 한 장. 대화 몇 마디. 기사 하나.</small>
          </span>
        </a>
        <div className="simple-connection">
          <span className={`dot ${status?.model ? "online" : ""}`} />
          {checking
            ? "연결 확인 중"
            : status?.model
              ? (status.textProvider === "claude" ? "Claude API 설정됨" : "로컬 AI 연결됨")
              : "AI 연결 확인 필요"}
          <button
            className="icon-button"
            disabled={checking}
            onClick={check}
            aria-label="연결 다시 확인"
          >
            <RotateCcw size={15} className={checking ? "spin" : ""} />
          </button>
        </div>
      </header>
      <ClaudeToggle />
      <main className="simple-main">
        <div className="simple-intro">
          <div>
            <h1>
              보고, 듣고, <span>기사로.</span>
            </h1>
            <p>불완전한 단서에서 AI가 하나의 사건을 상상합니다.</p>
          </div>
          <button
            className="button"
            disabled={busy || recording !== "off"}
            onClick={example}
          >
            <Sparkles size={15} />
            예시 사진
          </button>
        </div>
        <div className="simple-workspace">
          <GlassPanel className="simple-input">
            <h2>사진과 대화</h2>
            <label className="check-label consent">
              <input
                type="checkbox"
                checked={consent}
                disabled={busy || camera || recording !== "off"}
                onChange={(e) => setConsent(e.target.checked)}
              />
              사진과 대화 제공에 참여자 모두가 동의했습니다.
            </label>
            <div className="viewfinder">
              {camera ? (
                <video
                  ref={video}
                  autoPlay
                  playsInline
                  muted
                  onLoadedData={() => setCameraReady(true)}
                />
              ) : image ? (
                <img src={image} alt="기사에 사용할 입력 사진" />
              ) : (
                <div className="image-empty">
                  <Camera size={28} />
                  <p>사진 한 장을 담아주세요.</p>
                  <span>업로드하거나 웹캠으로 촬영하세요.</span>
                </div>
              )}
            </div>
            <div className="source-actions">
              <label
                className={`button ${busy || recording !== "off" ? "disabled" : ""}`}
              >
                <Upload size={15} />
                사진 올리기
                <input
                  type="file"
                  aria-label="사진 올리기"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={busy || recording !== "off"}
                  onChange={(e) => {
                    void upload(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
              {camera ? (
                <>
                  <button disabled={!cameraReady || busy} onClick={snap}>
                    촬영
                  </button>
                  <button aria-label="카메라 끄기" onClick={stopCamera}>
                    <X size={16} />
                  </button>
                </>
              ) : (
                <button
                  disabled={!consent || busy || recording !== "off"}
                  onClick={openCamera}
                >
                  <Camera size={15} />
                  웹캠
                </button>
              )}
            </div>
            <section className="simple-audio" aria-label="녹음한 대화">
              <div className="simple-audio-heading">
                <h3>녹음한 대화</h3>
                {recording === "off" ? (
                  <button
                    disabled={!consent || busy || !status?.whisper || pending}
                    onClick={conversation.start}
                  >
                    <Mic size={15} />
                    대화 녹음
                  </button>
                ) : (
                  <button
                    className="red-outline"
                    disabled={recording === "finishing"}
                    onClick={conversation.stop}
                  >
                    <Square size={13} />
                    {recording === "requesting"
                      ? "취소"
                      : recording === "finishing"
                        ? "녹음 마무리 중"
                        : "녹음 종료"}
                  </button>
                )}
              </div>
              {recording !== "off" && (
                <div className="audio-strip" role="status">
                  <span
                    className={`record-indicator ${recording === "recording" ? "recording" : ""}`}
                  />
                  <span>
                    {recording === "requesting"
                      ? "마이크 권한 확인 중"
                      : recording === "finishing"
                        ? "음성 파일을 준비하고 있어요"
                        : `REC · ${timecode(conversation.elapsed)}`}
                  </span>
                  <span className="audio-wave" aria-hidden="true">
                    {levels.map((v, i) => (
                      <i
                        key={i}
                        style={{
                          transform: `scaleY(${Math.max(0.08, v / 40)})`,
                        }}
                      />
                    ))}
                  </span>
                </div>
              )}
              {recording === "recording" && (
                <p className={`hint ${conversation.quiet ? "mic-quiet" : ""}`}>
                  {conversation.quiet
                    ? "입력 소리가 작아요. 마이크 위치와 입력 장치를 확인해주세요."
                    : `${conversation.device} · 종료하면 자동으로 음성을 인식합니다.`}
                </p>
              )}
              {clips.length > 0 ? (
                <>
                  <div className="recognized-clips" aria-live="polite">
                    {clips.map((c) => (
                      <div className="recognized-clip" key={c.id}>
                        <time>{timecode(c.time)}</time>
                        {c.pending ? (
                          <p className="transcribing-text">
                            <LoaderCircle size={13} className="spin" />
                            음성을 텍스트로 바꾸고 있어요.
                          </p>
                        ) : (
                          <p>{c.text}</p>
                        )}
                        <button
                          aria-label={`${timecode(c.time)} 녹취 삭제`}
                          disabled={busy}
                          onClick={() => conversation.remove(c.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    className="clear-conversation"
                    disabled={busy || recording !== "off"}
                    onClick={conversation.clear}
                  >
                    <Trash2 size={13} />
                    녹취 모두 지우기
                  </button>
                </>
              ) : (
                <p className="conversation-empty">
                  녹음하면 인식된 말이 여기에 표시됩니다.
                </p>
              )}
              <p className="hint">
                {pending
                  ? "음성 인식이 끝나면 기사에 사용할 수 있어요."
                  : status && !status.whisper
                    ? "Whisper 연결을 확인해주세요. 음성 인식에는 로컬 Whisper가 필요합니다."
                    : "말을 끊지 않고 최대 1분까지 녹음합니다. 인식된 녹취는 삭제할 수 있어요."}
              </p>
            </section>
            <button
              className="simple-generate"
              disabled={!ready || busy}
              onClick={generate}
            >
              {busy ? (
                <LoaderCircle size={20} className="spin" />
              ) : (
                <ArrowRight size={20} />
              )}
              <span>
                {busy
                  ? "기사 쓰는 중…"
                  : article
                    ? "새 기사 만들기"
                    : "기사 만들기"}
              </span>
            </button>
            <p className="simple-local-note">
              {busy
                ? "사진과 대화를 AI가 함께 읽고 있습니다."
                : !consent
                  ? "참여자 동의 후 촬영·녹음과 기사 생성이 가능합니다."
                  : "사진과 대화는 이 컴퓨터에서만 처리됩니다. 입력과 기사는 새로고침하면 지워집니다."}
            </p>
          </GlassPanel>
          <GlassPanel className="simple-story">
            <div className="simple-story-header">
              <h2>만들어진 기사</h2>
              <span className="fiction-label">AI가 만든 허구</span>
            </div>
            {busy && (
              <div className="simple-writing" role="status">
                <span className="record-indicator" />
                단서를 엮어 이야기를 쓰고 있어요.
              </div>
            )}
            {article ? (
              <article className="simple-article">
                <h3>{article.title}</h3>
                <p className="simple-lead">{article.summary}</p>
                <img src={articleImage} alt="이 기사의 입력으로 사용한 사진" />
                {article.body.map((c) => (
                  <p key={c.id}>{c.text}</p>
                ))}
                <p className="simple-fiction-note">
                  이 기사는 불완전한 사진과 대화를 AI가 재구성한 허구입니다.
                  실제 사건으로 확인된 내용이 아닙니다.
                </p>
              </article>
            ) : (
              <div className="simple-story-empty">
                <div className="glass-eye">
                  <Eye size={42} strokeWidth={1.5} />
                </div>
                <h3>아직 아무 일도 없었습니다.</h3>
                <p>
                  사진과 대화를 건네면,
                  <br />
                  여기에 하나의 기사가 도착합니다.
                </p>
              </div>
            )}
          </GlassPanel>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
            <button aria-label="오류 닫기" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        <footer className="simple-footer">
          THE OVERHEARD<span>모든 기사는 허구적 AI 재구성물입니다.</span>
        </footer>
      </main>
    </div>
  );
}
