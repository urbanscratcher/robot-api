import { chatFetch } from './ai.ts';
import {
  multimodalSchema,
  validateArticle,
  trackClaims,
} from "../src/domain.ts";
import type { Article, Intervention } from "../src/domain.ts";
import { system } from "./prompts.ts";
import { fail } from "./local.ts";
const recursiveSystem =
  system +
  `
추가 작성 규칙:
imagePrompt에는 기사 속 장면을 재구성할 SDXL용 영어 시각 묘사(약 50~100단어)를 작성한다. 익명의 인물·사물·장소·조명·분위기를 구체적으로 묘사하고 텍스트, 로고, 인물 식별은 제외한다. 제목이나 긴 기사 원문을 그대로 넣지 않는다.
body 항목의 relation은 새 주장일 때 new, 이전 주장을 의미상 반복할 때 inherited, 관객 삽입문을 사용했을 때 human이다. inherited는 반드시 실제 부모 sourceIds를 포함한다. 의미가 유사하다는 판단은 추정이다. 이전 AI의 주장과 생성 이미지에서 본 내용을 실제 원본의 사실로 승격하지 않는다. 재귀 세대에서는 눈에 보이는 요소도 AI 재구성물에 대한 추론이다. 누락 표시는 대화 발언이 아니므로 기사 인용으로 쓰지 않는다.`;
export async function interpret(
  image: Buffer,
  number: number,
  transcript: string | undefined,
  previous: Article | undefined,
  edit: Intervention,
  signal: AbortSignal,
) {
  const body = previous?.body
    .filter((c) => !edit.deleted.includes(c.id))
    .map((c) => ({ ...c, emphasized: edit.emphasized.includes(c.id) }));
  const input =
    number === 1
      ? {
          task: "사진과 불완전한 녹취에서 첫 기사와 이미지 프롬프트 작성",
          transcript,
        }
      : {
          task: "직전 AI 생성 이미지와 편집된 기사로 다음 허구적 기사 및 이미지 프롬프트 작성. 이전 AI 해석도 미검증 자료다.",
          previous: {
            title: previous?.title,
            body,
            interpretation: edit.deleted.length
              ? undefined
              : previous?.situation,
          },
          humanInsertion: edit.inserted,
          direction: edit.direction,
          imageDirection: edit.imagePrompt || undefined,
        };
  const response = await chatFetch(
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: multimodalSchema,
        options: { temperature: 0.8, num_predict: 4200 },
        messages: [
          { role: "system", content: recursiveSystem },
          {
            role: "user",
            content: JSON.stringify(input),
            images: [image.toString("base64")],
          },
        ],
      }),
    },
    240000,
    signal,
  );
  const result = await response.json();
  let article: Article;
  try {
    article = JSON.parse(result.message?.content);
    validateArticle(article);
    if (
      typeof article.imagePrompt !== "string" ||
      !article.imagePrompt.trim() ||
      article.imagePrompt.length > 4000 ||
      !article.body.every((c) =>
        ["new", "inherited", "human"].includes(c.relation ?? ""),
      )
    )
      throw Error();
  } catch {
    fail("AI의 기사·이미지 프롬프트 JSON이 유효하지 않습니다.", 502);
  }
  article.title = article.title.startsWith("[허구]")
    ? article.title
    : `[허구] ${article.title}`;
  const quoteSource =
    number === 1
      ? (transcript ?? "")
      : (body?.map((c) => c.text).join("\n") ?? "");
  article.quotes = article.quotes.filter(
    (q) =>
      q.trim() && !q.includes("[기록되지 않음]") && quoteSource.includes(q),
  );
  article = trackClaims(article, number, previous, edit);
  article.observedFacts = article.body
    .filter((c) => c.kind === "observation")
    .map((c) => c.text);
  article.inferredFacts = article.body
    .filter((c) => c.kind === "inference")
    .map((c) => c.text);
  article.inventedDetails = article.body
    .filter((c) => c.kind === "fiction")
    .map((c) => c.text);
  return article;
}
export async function compareImages(
  before: Buffer,
  after: Buffer,
  signal: AbortSignal,
) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["added", "removed"],
    properties: {
      added: { type: "array", maxItems: 6, items: { type: "string" } },
      removed: { type: "array", maxItems: 6, items: { type: "string" } },
    },
  };
  const r = await chatFetch(
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: schema,
        options: { temperature: 0.1, num_predict: 800 },
        messages: [
          {
            role: "system",
            content:
              "첫 이미지는 입력, 두 번째 이미지는 AI 생성 결과다. 눈에 보이는 주요 요소의 추가·삭제만 한국어로 비교한다. 사람의 정체·의도·사건은 추론하지 않는다. 차이를 식별하지 못하면 빈 배열로 답한다. 이 비교는 AI의 미검증 추정이다.",
          },
          {
            role: "user",
            content:
              "두 이미지의 추가된 요소(added)와 사라진 요소(removed)를 JSON으로 기록해.",
            images: [before.toString("base64"), after.toString("base64")],
          },
        ],
      }),
    },
    120000,
    signal,
  );
  if (!r.ok) throw Error(`이미지 비교 실패 (${r.status})`);
  const data = await r.json();
  const diff = JSON.parse(data.message?.content);
  if (
    !["added", "removed"].every(
      (key) =>
        Array.isArray(diff[key]) &&
        diff[key].every((s: unknown) => typeof s === "string"),
    )
  )
    throw Error("이미지 비교 JSON 오류");
  return diff as { added: string[]; removed: string[] };
}
