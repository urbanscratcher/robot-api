import type { ReactNode } from "react";
import { GlassPanel, GenerationStatus, ReproduceButton } from "./GlassUI";
import { Eye, Hand, Square, Upload, X, ChevronDown } from "lucide-react";
import type { Generation, Intervention, Job } from "./domain";
import { isActiveJob } from "./domain";
export type Mode = "manual" | "auto" | "human";
export function PipelineControls({
  mode,
  setMode,
  max,
  setMax,
  job,
  busy,
  ready,
  onGenerate,
  onStop,
  count,
  hint,
}: {
  mode: Mode;
  setMode: (m: Mode) => void;
  max: number;
  setMax: (n: number) => void;
  job: Job | null;
  busy: boolean;
  ready: boolean;
  onGenerate: () => void;
  onStop: () => void;
  count: number;
  hint?: string;
}) {
  return (
    <section className="pipeline-controls" aria-label="재생산 제어">
      <div className="mode-buttons">
        {(["manual", "auto", "human"] as const).map((m) => (
          <button
            key={m}
            aria-pressed={mode === m}
            disabled={busy}
            onClick={() => setMode(m)}
          >
            {m === "manual"
              ? "Manual"
              : m === "auto"
                ? "Auto"
                : "Human-in-the-loop"}
          </button>
        ))}
      </div>
      <p>
        {mode === "auto"
          ? "검토를 기다리지 않고 지정한 세대까지 순차 생산합니다."
          : mode === "human"
            ? "최신 기사의 문장·이미지·프롬프트에 개입한 뒤 다음 세대를 만듭니다."
            : "버튼을 누를 때마다 기사와 이미지를 한 세대씩 만듭니다."}
      </p>
      <div className="run-row">
        {mode === "auto" && (
          <label>
            최대 세대{" "}
            <input
              aria-label="최대 세대 수"
              type="number"
              min={count + 1}
              max={30}
              value={max}
              disabled={busy}
              onChange={(e) => setMax(Number(e.target.value))}
            />
          </label>
        )}
        <ReproduceButton
          onClick={onGenerate}
          disabled={
            !ready || busy || count >= 30 || (mode === "auto" && max <= count)
          }
          busy={busy}
          count={count}
          mode={mode}
        />
        {isActiveJob(job) && (
          <button
            className="stop-production"
            onClick={onStop}
            disabled={job?.status === "stopping"}
          >
            <Square size={13} />
            {job?.status === "stopping" ? "중지 중" : "즉시 중지"}
          </button>
        )}
      </div>
      {hint && !busy && <p className="readiness-hint">{hint}</p>}
      <div className="job-progress">
        <GenerationStatus job={job} busy={busy} />
        {job && (
          <span className="job-limit">
            Generation {job.currentGeneration} / {job.targetGeneration}
          </span>
        )}
      </div>
      {job?.error && (
        <p className="job-error" role="alert">
          {job.error}
        </p>
      )}
      {job?.cancellationWarning && (
        <p className="job-error" role="alert">
          {job.cancellationWarning}
        </p>
      )}
    </section>
  );
}
export function ImageStage({
  original,
  active,
  generations,
  onSelect,
  selected,
  busy,
  job,
  children,
  hidden,
  tabbed,
}: {
  original: string;
  active?: Generation;
  generations: Generation[];
  onSelect: (n: number) => void;
  selected: number;
  busy: boolean;
  job: Job | null;
  children?: ReactNode;
  hidden?: boolean;
  tabbed?: boolean;
}) {
  const current = active?.generatedImage;
  const before = active?.inputImage;
  return (
    <GlassPanel
      className="image-stage"
      id="reproduction-panel"
      hidden={hidden}
      role={tabbed ? "tabpanel" : "region"}
      aria-label="Reproduction"
      aria-labelledby={tabbed ? "tab-reproduction" : undefined}
    >
      <div className="section-top">
        <h2>
          <span className="panel-symbol">
            <Eye size={18} />
          </span>{" "}
          Reproduction
        </h2>
        <span>
          {active?.demo ? "DEMO / 합성 시뮬레이션" : "AI 재구성 · 원본 아님"}
        </span>
      </div>
      <div
        className={`image-stack ${busy ? "is-busy" : ""}`}
        style={
          {
            "--stack-depth": Math.min(generations.length, 3),
          } as React.CSSProperties
        }
      >
        {generations
          .filter((g) => g.number < (active?.number ?? generations.length + 1))
          .slice(-2)
          .map((g, i) => (
            <div
              className={`stack-sheet sheet-${i}`}
              key={g.id ?? g.number}
              aria-hidden="true"
            >
              <img src={g.generatedImage || original} alt="" />
            </div>
          ))}
        <div
          className="generated-frame"
          key={active?.id ?? active?.number ?? "empty"}
        >
          {current ? (
            <img
              src={current}
              alt={`Generation ${active?.number} ${active?.demo ? "데모 합성" : "AI 생성"} 이미지 · 실제 사진 아님`}
            />
          ) : (
            <div className="image-stage-empty">
              <div className="glass-eye">
                <Eye size={48} strokeWidth={1.5} />
              </div>
              <h3>
                {busy
                  ? (job?.phase ?? "생성 준비 중")
                  : "어떤 이야기가\n숨어 있을까요?"}
              </h3>
              <p>
                사진 한 장과 대화의 조각에서
                <br />
                AI가 새로운 장면을 상상합니다.
              </p>
            </div>
          )}
          <span className="generated-caption">
            {active
              ? `GEN ${String(active.number).padStart(2, "0")} / ${active.demo ? "DEMO SYNTHETIC FRAME" : "SDXL RECONSTRUCTION"}`
              : "WAITING FOR REPRODUCTION"}
          </span>
        </div>
      </div>
      {children}
      {active && (
        <>
          <div className="image-parameters">
            <span>SEED {active.seed ?? "—"}</span>
            <span>DENOISE {active.denoise ?? "—"}</span>
            <span>{((active.generationDuration ?? 0) / 1000).toFixed(1)}s</span>
          </div>
          <details className="image-comparison" open>
            <summary>
              이전과 지금, 나란히 <ChevronDown size={16} />
            </summary>
            <div className="image-pair">
              <figure>
                <img src={before || original} alt="이 세대의 입력 이미지" />
                <figcaption>
                  {active.intervention.replacementImage
                    ? "HUMAN INPUT"
                    : active.number === 1
                      ? "GEN 00 / 원본"
                      : `GEN ${active.number - 1} / AI`}
                </figcaption>
              </figure>
              <figure>
                <img src={current} alt="이 세대의 재구성 결과" />
                <figcaption>
                  GEN {active.number} / {active.demo ? "DEMO" : "AI"}
                </figcaption>
              </figure>
            </div>
          </details>
          <details className="prompt-details">
            <summary>이 이미지에 사용한 프롬프트</summary>
            <p>{active.imagePrompt}</p>
          </details>
          {active.imageComparisonError && (
            <p className="job-error">
              이미지 비교 미완료: {active.imageComparisonError}
            </p>
          )}
        </>
      )}
    </GlassPanel>
  );
}
export function ImageIntervention({
  edit,
  setEdit,
  busy,
  onUpload,
  currentPrompt,
}: {
  edit: Intervention;
  setEdit: (fn: (p: Intervention) => Intervention) => void;
  busy: boolean;
  onUpload: (file?: File) => void;
  currentPrompt?: string;
}) {
  return (
    <div className="image-intervention">
      {currentPrompt && (
        <button
          className="text-button"
          disabled={busy}
          onClick={() => setEdit((p) => ({ ...p, imagePrompt: currentPrompt }))}
        >
          직전 프롬프트를 가져와 편집
        </button>
      )}
      <label className="field-label" htmlFor="image-prompt">
        다음 이미지 프롬프트 덮어쓰기 <span>영어 권장</span>
      </label>
      <textarea
        id="image-prompt"
        rows={3}
        maxLength={4000}
        value={edit.imagePrompt ?? ""}
        disabled={busy}
        onChange={(e) =>
          setEdit((p) => ({ ...p, imagePrompt: e.target.value }))
        }
        placeholder="비워두면 AI가 새 프롬프트를 작성합니다. 입력하면 이 문장을 ComfyUI에 그대로 전달합니다."
      />
      <label className={`button ${busy ? "disabled" : ""}`}>
        <Upload size={13} />
        다음 입력 이미지 교체
        <input
          aria-label="다음 입력 이미지 교체"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => {
            onUpload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      {edit.replacementImage && (
        <div className="replacement-preview">
          <img
            src={edit.replacementImage}
            alt="관객이 교체할 다음 입력 이미지"
          />
          <button
            disabled={busy}
            onClick={() =>
              setEdit((p) => ({ ...p, replacementImage: undefined }))
            }
          >
            <X size={12} />
            교체 취소
          </button>
        </div>
      )}
    </div>
  );
}
