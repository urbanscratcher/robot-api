import type { Generation, ClaimOrigin } from "./domain";
import { hasIntervention } from "./domain";
export const originLabels: Record<ClaimOrigin, string> = {
  ORIGINAL_OBSERVATION: "원본 관찰",
  AI_INFERENCE: "AI 추론",
  AI_INVENTION: "AI 창작",
  INHERITED_AI_CLAIM: "AI 주장 계승",
  HUMAN_INTERVENTION: "인간 삽입",
};
export function ProductionStats({
  generations,
  reviewed,
}: {
  generations: Generation[];
  reviewed: number[];
}) {
  const human = generations.filter((g) =>
    hasIntervention(g.intervention),
  ).length;
  const elapsed =
    generations.reduce((n, g) => n + (g.generationDuration ?? 0), 0) / 1000;
  const metrics = [
    ["기사 생산", generations.length],
    ["이미지 생산", generations.filter((g) => g.generatedImage).length],
    ["자동 생성", generations.filter((g) => g.automatic).length],
    ["인간 개입", human],
    ["검토 완료", reviewed.length],
    [
      "파생 주장",
      generations
        .flatMap((g) => g.article.body)
        .filter((c) => c.origin !== "ORIGINAL_OBSERVATION").length,
    ],
  ];
  return (
    <section className="production-stats" aria-label="생산과 검토 통계">
      <div className="stats-title">
        <h2>한 장면이 만든 이야기들</h2>
        <span>
          누적 생성 {elapsed.toFixed(1)}초 · 검토 완료는 관객이 직접 표시합니다.
        </span>
      </div>
      <div className="metric-grid">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <p>
        AI가 생산한 {generations.length}세대 중 {reviewed.length}세대를
        검토했습니다. {Math.max(0, generations.length - reviewed.length)}세대는
        아직 검토 표시가 없습니다.
        {generations.some((g) => g.demo) &&
          " 데모의 수치·시간은 시뮬레이션입니다."}
      </p>
    </section>
  );
}
export function TransformationLog({
  generation,
  previous,
}: {
  generation?: Generation;
  previous?: Generation;
}) {
  if (!generation?.changes) return null;
  const changes = generation.changes;
  const rows = [
    ["새로 등장", changes.newClaimIds],
    ["계승됨 · AI 추정", changes.inheritedClaimIds],
    ["인간 삽입", changes.humanClaimIds],
    ["사라짐 · AI 추정", changes.disappearedClaimIds],
  ] as const;
  function text(id: string) {
    return (
      generation?.article.body.find((c) => c.id === id)?.text ??
      previous?.article.body.find((c) => c.id === id)?.text ??
      id
    );
  }
  return (
    <details className="transformation-log glass-panel">
      <summary className="transformation-title">
        정보가 바뀐 흔적<span>GEN {generation.number} · AI의 비교 추정</span>
      </summary>
      <div className="transformation-content">
        <div className="section-top">
          <h2>정보 변형 기록 / GEN {generation.number}</h2>
          <span>AI ESTIMATE / 사실 검증 아님</span>
        </div>
        <div className="change-columns">
          {rows.map(([label, ids]) => (
            <div key={label}>
              <h3>
                {label} <span>{ids.length}</span>
              </h3>
              {ids.length ? (
                ids.map((id) => (
                  <p key={id}>
                    <small>{id}</small>
                    {text(id)}
                  </p>
                ))
              ) : (
                <p className="hint">기록 없음</p>
              )}
            </div>
          ))}
        </div>
        <div className="visual-diff">
          <h3>
            이미지 변화{" "}
            <span>
              {changes.imageComparison === "DEMO"
                ? "데모 시뮬레이션"
                : changes.imageComparison === "UNAVAILABLE"
                  ? "비교 미완료"
                  : "두 이미지를 비교한 AI의 추정"}
            </span>
          </h3>
          <div>
            <p>+ 추가 {changes.imageAdded.join(" / ") || "식별된 요소 없음"}</p>
            <p>
              − 삭제 {changes.imageRemoved.join(" / ") || "식별된 요소 없음"}
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}
