import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTranscript } from "./transcript.ts";
test("strip placeholders, not spoken language", () => {
  for (const marker of [
    "[기록되지 않음]",
    "[음성 인식 없음]",
    "[음식 인식 없음]",
    "음성 인식 없음",
    "[BLANK_AUDIO]",
    "[00:03] [기록되지 않음]",
    "[전사 실패 · 직접 입력 필요]",
  ])
    assert.equal(cleanTranscript(marker), "", marker);
  assert.equal(
    cleanTranscript("오늘 [기록되지 않음] 다시 만나요."),
    "오늘 다시 만나요.",
  );
  assert.equal(
    cleanTranscript("기록되지 않음이라고 쓰여 있어요."),
    "기록되지 않음이라고 쓰여 있어요.",
  );
  assert.equal(
    cleanTranscript("[오늘] 오후 세 시에 만나자."),
    "[오늘] 오후 세 시에 만나자.",
  );
  assert.equal(cleanTranscript(undefined), "");
});
