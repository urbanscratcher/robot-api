import { useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import {
  ArrowUpRight,
  Eye,
  Hand,
  Layers,
  Settings2,
  X,
  RefreshCw,
  ShieldCheck,
  Square,
} from "lucide-react";
import {
  hasIntervention,
  isActiveJob,
  type Generation,
  type Job,
} from "./domain";
export function GlassPanel({
  as: Tag = "section",
  className = "",
  children,
  ...props
}: ComponentPropsWithoutRef<"section"> & {
  as?: "section" | "aside" | "div";
  children: ReactNode;
}) {
  return (
    <Tag className={`glass-panel ${className}`} {...props}>
      {children}
    </Tag>
  );
}
function phaseIndex(job: Job | null) {
  if (!job) return -1;
  if (job.phase.includes("COMFYUI")) return 3;
  if (job.phase.includes("이미지 변화")) return 4;
  if (job.phase.includes("기사와 이미지")) return 1;
  return 0;
}
export function GenerationStatus({
  job,
  busy,
}: {
  job: Job | null;
  busy: boolean;
}) {
  const index = phaseIndex(job),
    active = isActiveJob(job),
    done = job?.status === "completed";
  const labels = [
    "OBSERVING",
    "INTERPRETING",
    "WRITING",
    "RECONSTRUCTING",
    "REPRODUCING",
  ];
  const title =
    job?.status === "stopping"
      ? "안전하게 멈추는 중이에요."
      : job?.status === "stopped"
        ? "완료된 이야기는 그대로 남아 있어요."
        : job?.status === "failed"
          ? "잠시 멈췄어요. 아래 오류를 확인해주세요."
          : busy
            ? index === 1
              ? "해석하고, 이야기를 쓰고 있어요."
              : index === 3
                ? "이야기를 새로운 이미지로 옮기는 중이에요."
                : index === 4
                  ? "바뀐 장면을 비교하고 기록하고 있어요."
                  : "다음 이야기의 단서를 준비하고 있어요."
            : done
              ? "새로운 이야기가 도착했어요."
              : "작은 단서로, 다음 이야기를 시작해요.";
  return (
    <div
      className={`generation-status ${active ? "is-active" : ""}`}
      data-stage={index}
    >
      <div className="status-heading">
        <span className="status-eye">
          <Eye size={17} />
        </span>
        <span role="status" aria-live="polite">
          {title}
        </span>
        {job && (
          <span className="status-generation">
            G{String(job.currentGeneration).padStart(2, "0")}
          </span>
        )}
      </div>
      <ol className="phase-steps" aria-label="생성 단계">
        {labels.map((label, i) => {
          const isCurrent =
            active && (index === 1 ? i === 1 || i === 2 : i === index);
          const complete =
            done || (active && (index === 1 ? i < 1 : i < index));
          return (
            <li
              key={label}
              className={isCurrent ? "current" : complete ? "complete" : ""}
              aria-current={isCurrent ? "step" : undefined}
            >
              <span />
              {label}
            </li>
          );
        })}
      </ol>
      {active && (
        <p className="phase-detail">
          {job?.phase}{" "}
          {index === 1 &&
            "· 해석과 기사는 하나의 모델 요청으로 함께 작성됩니다."}
        </p>
      )}
    </div>
  );
}
export function ReproduceButton({
  onClick,
  disabled,
  busy,
  count,
  mode = "manual",
  compact = false,
}: {
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
  count: number;
  mode?: string;
  compact?: boolean;
}) {
  const accessible =
    mode === "auto"
      ? "자동 재생산 시작"
      : count
        ? "다시 보도하기"
        : "헤드라인·이미지 생성";
  return (
    <button
      className={`reproduce-button ${compact ? "compact" : ""}`}
      aria-label={`${accessible} · REPRODUCE`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="reproduce-symbol">
        <Layers size={compact ? 20 : 24} strokeWidth={1.7} />
      </span>
      <span className="reproduce-copy">
        <strong>{busy ? "REPRODUCING" : "REPRODUCE"}</strong>
        <small>
          {busy
            ? "다음 이야기를 만들고 있어요"
            : mode === "auto"
              ? "다음 세대들을 차례로"
              : `Generation ${String(count + 1).padStart(2, "0")} 만들기`}
        </small>
      </span>
      <ArrowUpRight size={compact ? 20 : 23} />
    </button>
  );
}
export function MobileDock({
  busy,
  ready,
  job,
  count,
  mode,
  onGenerate,
  onStop,
  hint,
  onHint,
}: {
  busy: boolean;
  ready: boolean;
  job: Job | null;
  count: number;
  mode: string;
  onGenerate: () => void;
  onStop: () => void;
  hint: string;
  onHint: () => void;
}) {
  return (
    <div className="mobile-dock">
      <div className="dock-content">
        {!ready && !busy && (
          <button className="dock-hint" onClick={onHint}>
            {hint}
            <ArrowUpRight size={12} />
          </button>
        )}
        <div className="dock-actions">
          <ReproduceButton
            compact
            busy={busy}
            disabled={!ready || busy}
            count={count}
            mode={mode}
            onClick={onGenerate}
          />
          {isActiveJob(job) && (
            <button
              className="dock-stop"
              aria-label="즉시 중지"
              onClick={onStop}
              disabled={job?.status === "stopping"}
            >
              <Square size={18} />
              <span>중지</span>
            </button>
          )}
        </div>
        {busy && <p role="status">{job?.phase ?? "생성 준비 중"}</p>}
      </div>
    </div>
  );
}
export function GenerationTimeline({
  image,
  generations,
  selected,
  onSelect,
}: {
  image: string;
  generations: Generation[];
  selected: number;
  onSelect: (n: number) => void;
}) {
  if (!image) return null;
  return (
    <section className="generation-timeline" aria-label="Generation Timeline">
      <div className="timeline-heading">
        <div>
          <Layers size={19} />
          <h2>이야기가 쌓이는 곳</h2>
          <span>{generations.length} stories, and counting</span>
        </div>
        <p>장면을 선택해 의미가 달라진 순간을 살펴보세요.</p>
      </div>
      <div className="timeline-rail">
        <button
          className={`generation-tile original-tile ${selected === 0 ? "selected" : ""}`}
          onClick={() => onSelect(0)}
          aria-pressed={selected === 0}
        >
          <div className="tile-image">
            <img src={image} alt="Generation 00 원본 관찰" />
            <span className="tile-generation">GEN 00</span>
          </div>
          <div className="tile-info">
            <h3>모든 이야기가 시작된 장면</h3>
            <p>Original observation</p>
            <span className="tile-label">
              <ShieldCheck size={12} />
              원본 기록
            </span>
          </div>
        </button>
        {generations.map((g) => (
          <button
            key={g.id ?? g.number}
            className={`generation-tile ${selected === g.number ? "selected" : ""}`}
            onClick={() => onSelect(g.number)}
            aria-pressed={selected === g.number}
          >
            <div className="tile-image">
              <img
                src={g.generatedImage || image}
                alt={`Generation ${g.number} ${g.demo ? "데모" : "AI 생성"} 이미지`}
              />
              <span className="tile-generation">
                GEN {String(g.number).padStart(2, "0")}
              </span>
              {hasIntervention(g.intervention) && (
                <span className="tile-human" title="인간 개입이 반영된 세대">
                  <Hand size={14} />
                  <span className="sr-only">인간 개입</span>
                </span>
              )}
            </div>
            <div className="tile-info">
              <h3>{g.article.title}</h3>
              <p>
                <span>{((g.generationDuration ?? 0) / 1000).toFixed(1)}s</span>
                <span>새 주장 {g.changes?.newClaimIds.length ?? 0}개</span>
              </p>
              <span className="tile-label">
                {g.demo ? "Demo reconstruction" : "AI reconstruction"}
                <ArrowUpRight size={12} />
              </span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
export function ConnectionSettings({
  checking,
  onCheck,
  status,
}: {
  checking: boolean;
  onCheck: () => void;
  status: {
    model: boolean;
    checkpoint: boolean;
    comfyCompatible: boolean;
    whisper: boolean;
  } | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        className="settings-button icon-button"
        aria-label="Settings · 연결 설정"
        onClick={() => dialog.current?.showModal()}
      >
        <Settings2 size={19} />
      </button>
      <dialog
        ref={dialog}
        className="settings-dialog glass-panel"
        aria-labelledby="settings-title"
      >
        <div className="settings-heading">
          <h2 id="settings-title">이 기기의 연결</h2>
          <button
            className="icon-button"
            aria-label="설정 닫기"
            onClick={() => dialog.current?.close()}
          >
            <X size={18} />
          </button>
        </div>
        <p>사진과 대화는 외부 AI 서버로 보내지 않습니다.</p>
        <dl>
          {[
            ["Ollama", "127.0.0.1:11434", status?.model],
            [
              "ComfyUI",
              "127.0.0.1:8188",
              status?.checkpoint && status.comfyCompatible,
            ],
            ["Whisper", "127.0.0.1:8080", status?.whisper],
          ].map(([name, url, connected]) => (
            <div key={String(name)}>
              <dt>
                {name}
                <span
                  className={
                    connected ? "connected-label" : "disconnected-label"
                  }
                >
                  {status ? (connected ? "연결됨" : "미연결") : "확인 전"}
                </span>
              </dt>
              <dd>{url}</dd>
            </div>
          ))}
        </dl>
        <button className="button" disabled={checking} onClick={onCheck}>
          <RefreshCw size={15} className={checking ? "spin" : ""} />
          {checking ? "확인하는 중" : "연결 다시 확인"}
        </button>
        <p className="hint">
          Whisper 없이도 녹취를 직접 입력할 수 있습니다. 원본과 완료된 세대는
          로컬 보관함에 저장됩니다.
        </p>
      </dialog>
    </>
  );
}
