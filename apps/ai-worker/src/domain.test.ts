import { test } from "node:test";
import assert from "node:assert/strict";
import { validateArticle, lineage } from "./domain.ts";
const raw = () => ({
  title: "[허구] 제목",
  summary: "추측 요약",
  situation: "추측 상황",
  body: [
    { text: "관찰", kind: "observation" as const, sourceIds: [] as string[] },
    { text: "추론", kind: "inference" as const, sourceIds: [] as string[] },
    { text: "창작", kind: "fiction" as const, sourceIds: [] as string[] },
  ],
  quotes: [],
  alternatives: ["대안1", "대안2"],
});
test("reject malformed model JSON including claim classification", () => {
  validateArticle(raw());
  assert.throws(() =>
    validateArticle({
      ...raw(),
      body: [{ text: "x", kind: "fact", sourceIds: [] }],
    }),
  );
  assert.throws(() => validateArticle({ ...raw(), alternatives: [] }));
  assert.throws(() => validateArticle(null));
});
test("lineage filters invented source IDs, preserves exact first appearance, downgrades observation", () => {
  const previous = lineage(raw(), 1);
  const next = raw();
  next.body[0].sourceIds = ["g1-c1", "nonexistent"];
  next.body[1].text = "새로운 추측";
  const result = lineage(next, 2, previous);
  assert.deepEqual(result.body[0].sourceIds, ["g1-c1"]);
  assert.equal(result.body[0].firstGeneration, 1);
  assert.equal(result.body[0].kind, "inference");
  assert.equal(result.body[1].firstGeneration, 2);
  assert.equal(result.body[0].id, "g2-c1");
});

test("semantic lineage is marked as an estimate and never promotes inherited AI claims to original facts", async () => {
  const { trackClaims, emptyIntervention, migrateGeneration } = await import(
    "./domain.ts"
  );
  const previous = lineage(raw(), 1);
  const next = raw();
  Object.assign(next.body[0], {
    text: "관찰을 다른 말로 바꾸었다",
    relation: "inherited",
    sourceIds: ["g1-c1", "fabricated"],
  });
  const result = trackClaims(next as any, 2, previous, emptyIntervention());
  assert.equal(result.body[0].semanticMatch, true);
  assert.equal(result.body[0].origin, "INHERITED_AI_CLAIM");
  assert.equal(result.body[0].kind, "inference");
  assert.deepEqual(result.body[0].sourceIds, ["g1-c1"]);
  assert.equal(result.body[0].firstGeneration, 1);
  const deleted = trackClaims(next as any, 2, previous, {
    ...emptyIntervention(),
    deleted: ["g1-c1"],
  });
  assert.notEqual(deleted.body[0].origin, "INHERITED_AI_CLAIM");
  assert.equal(deleted.body[0].firstGeneration, 2);
  const migrated = migrateGeneration({
    number: 1,
    article: previous,
    intervention: emptyIntervention(),
    demo: false,
  });
  assert.equal(migrated.generationNumber, 1);
  assert.equal(migrated.article, previous);
  assert.deepEqual(migrated.claims, previous.body);
});

test("legacy generations retain parent linkage without persisted IDs", async () => {
  const { migrateGeneration, emptyIntervention } = await import("./domain.ts");
  const previous = {
    number: 1,
    article: lineage(raw(), 1),
    intervention: emptyIntervention(),
    demo: false,
  };
  const next = migrateGeneration({ ...previous, number: 2 }, previous);
  assert.equal(next.parentId, "legacy-g1");
  assert.equal(next.id, "legacy-g2");
});
