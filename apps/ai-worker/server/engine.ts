import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Article,
  Generation,
  Intervention,
  Job,
  Session,
  Changes,
} from "../src/domain.ts";
import { emptyIntervention, trackClaims } from "../src/domain.ts";
import { demoArticle } from "../src/demo.ts";
import { generateImage, cancelComfy } from "./comfy.ts";
import { interpret, compareImages } from "./interpret.ts";
import {
  getSession,
  saveSession,
  readAsset,
  writeAsset,
  sessionDir,
  decodeImage,
} from "./store.ts";
import { fail } from "./local.ts";
type Running = {
  job: Job;
  controller: AbortController;
  promptId?: string;
  done: Promise<void>;
};
let running: Running | null = null;
export function activeJob() {
  return running?.job ?? null;
}
function validateEdit(edit: Intervention, previous: Generation | undefined) {
  if (
    !edit ||
    !Array.isArray(edit.deleted) ||
    !Array.isArray(edit.emphasized) ||
    ![...edit.deleted, ...edit.emphasized].every(
      (id) =>
        typeof id === "string" &&
        previous?.article.body.some((c) => c.id === id),
    ) ||
    typeof edit.inserted !== "string" ||
    edit.inserted.length > 2000 ||
    typeof edit.direction !== "string" ||
    edit.direction.length > 1000 ||
    (edit.imagePrompt !== undefined &&
      (typeof edit.imagePrompt !== "string" ||
        edit.imagePrompt.length > 4000)) ||
    (edit.replacementImage !== undefined &&
      typeof edit.replacementImage !== "string")
  )
    fail("개입 내용이 유효하지 않습니다.");
  if (edit.replacementImage) decodeImage(edit.replacementImage);
}
function demoFrame(n: number) {
  const shift = Math.min(n, 12) * 9;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="512" viewBox="0 0 768 512"><rect width="768" height="512" fill="#252525"/><rect x="45" y="35" width="678" height="300" fill="#aaa"/>${Array.from({ length: 6 }, (_, i) => `<rect x="${70 + i * 120}" y="35" width="8" height="300" fill="#444"/>`).join("")}<path d="M0 512L45 335H723L768 512" fill="#555"/><rect x="170" y="310" width="420" height="18" fill="#161616"/><circle cx="${280 - shift}" cy="240" r="27" fill="#191919"/><rect x="${253 - shift}" y="266" width="54" height="44" fill="#191919"/><circle cx="${490 + shift}" cy="245" r="25" fill="#191919"/><rect x="${465 + shift}" y="270" width="50" height="40" fill="#191919"/><rect x="${360 + shift}" y="295" width="${35 + n * 6}" height="15" fill="#ef483b"/><text x="25" y="480" fill="#eee" font-family="monospace" font-size="13">DEMO / SYNTHETIC FRAME / GEN ${n}</text></svg>`,
  );
}
export async function startJob(
  id: string,
  options: {
    mode?: string;
    maxGenerations?: number;
    intervention?: Intervention;
  },
) {
  if (running)
    fail("다른 생성이 진행 중입니다. 완료 또는 중지 후 다시 시도하세요.", 409);
  const session = await getSession(id);
  const edit = options.intervention ?? emptyIntervention();
  validateEdit(edit, session.generations.at(-1));
  const automatic = options.mode === "auto";
  if (options.mode && !["auto", "manual", "human"].includes(options.mode))
    fail("생성 모드가 유효하지 않습니다.");
  const target = automatic
    ? (options.maxGenerations ?? 5)
    : session.generations.length + 1;
  if (
    !Number.isInteger(target) ||
    target < 1 ||
    target > 30 ||
    target <= session.generations.length
  )
    fail("최대 세대는 현재보다 큰 1~30 범위로 설정하세요.");
  // Acquire the single worker before the first asynchronous write.
  if (running) fail("다른 생성이 진행 중입니다.", 409);
  const job: Job = {
    id: randomUUID(),
    sessionId: id,
    status: "running",
    phase: "준비",
    currentGeneration: session.generations.length + 1,
    targetGeneration: target,
    createdAt: new Date().toISOString(),
  };
  const task: Running = {
    job,
    controller: new AbortController(),
    done: Promise.resolve(),
  };
  running = task;
  session.job = job;
  try {
    await saveSession(session);
  } catch (e) {
    running = null;
    throw e;
  }
  task.done = execute(session, task, edit, automatic);
  return job;
}
async function execute(
  session: Session,
  task: Running,
  firstEdit: Intervention,
  automatic: boolean,
) {
  const { job, controller } = task;
  const signal = controller.signal;
  const phase = async (name: string) => {
    signal.throwIfAborted();
    job.phase = name;
    await saveSession(session);
  };
  try {
    while (session.generations.length < job.targetGeneration) {
      signal.throwIfAborted();
      const previous = session.generations.at(-1);
      const number = session.generations.length + 1;
      job.currentGeneration = number;
      const started = Date.now();
      const edit = firstEdit;
      // Human edits apply once; subsequent auto generations have no new human instruction.
      firstEdit = emptyIntervention();
      let inputImage =
        number === 1 ? session.original.image : previous?.generatedImage;
      if (!inputImage)
        fail(
          "직전 세대의 생성 이미지가 없습니다. 원본을 대신 사용하지 않습니다.",
        );
      let recordedEdit = { ...edit };
      if (edit.replacementImage) {
        const decoded = decodeImage(edit.replacementImage);
        inputImage = await writeAsset(
          session.id,
          `g${number}-human.${decoded.extension}`,
          decoded.buffer,
        );
        recordedEdit = { ...edit, replacementImage: inputImage };
      }
      const input = await readAsset(session.id, inputImage);
      await phase("CLAUDE · 기사와 이미지 프롬프트 작성");
      let article: Article;
      if (session.demo) {
        await delay(350, undefined, { signal });
        article = demoArticle(number, previous?.article, edit);
        article.imagePrompt = `Fictional surveillance scene, two anonymous silhouettes at a table, red envelope, generation ${number}, monochrome documentary still, no text`;
        article = trackClaims(
          {
            ...article,
            body: article.body.map((c) => ({
              ...c,
              relation: c.sourceIds.length
                ? "inherited"
                : c.text.includes("관객 삽입")
                  ? "human"
                  : "new",
            })),
          },
          number,
          previous?.article,
          edit,
        );
      } else
        article = await interpret(
          input.buffer,
          number,
          number === 1 ? session.original.transcript : undefined,
          previous?.article,
          edit,
          signal,
        );
      const imagePrompt = edit.imagePrompt?.trim() || article.imagePrompt!;
      article.imagePrompt = imagePrompt;
      await phase("COMFYUI · SDXL 이미지 재구성");
      let generatedImage: string,
        seed = 0,
        denoise = 0.45;
      if (session.demo) {
        await delay(350, undefined, { signal });
        generatedImage = await writeAsset(
          session.id,
          `g${number}-generated.svg`,
          demoFrame(number),
        );
      } else {
        const result = await generateImage(
          input.buffer,
          input.mime,
          imagePrompt,
          signal,
          async (id) => {
            task.promptId = id;
            job.comfyPromptId = id;
            await saveSession(session);
          },
        );
        seed = result.seed;
        denoise = result.denoise;
        generatedImage = await writeAsset(
          session.id,
          `g${number}-generated.png`,
          result.buffer,
        );
        task.promptId = undefined;
        delete job.comfyPromptId;
        await writeFile(
          join(sessionDir(session.id), `g${number}-workflow.json`),
          JSON.stringify(result.workflow, null, 2),
        );
      }
      await phase("CLAUDE · 이미지 변화 비교");
      const changes: Changes = {
        newClaimIds: article.body
          .filter(
            (c) =>
              c.origin !== "INHERITED_AI_CLAIM" &&
              c.origin !== "HUMAN_INTERVENTION",
          )
          .map((c) => c.id),
        inheritedClaimIds: article.body
          .filter((c) => c.origin === "INHERITED_AI_CLAIM")
          .map((c) => c.id),
        humanClaimIds: article.body
          .filter((c) => c.origin === "HUMAN_INTERVENTION")
          .map((c) => c.id),
        disappearedClaimIds:
          previous?.article.body
            .filter(
              (p) => !article.body.some((c) => c.sourceIds.includes(p.id)),
            )
            .map((c) => c.id) ?? [],
        imageAdded: [],
        imageRemoved: [],
        imageComparison: session.demo ? "DEMO" : "AI_ESTIMATE",
      };
      let imageComparisonError: string | undefined;
      if (session.demo) {
        changes.imageAdded = [`데모 봉투의 크기·위치 변형 G${number}`];
        changes.imageRemoved = ["직전 실루엣의 위치"];
      } else {
        try {
          const output = await readAsset(session.id, generatedImage);
          const diff = await compareImages(input.buffer, output.buffer, signal);
          changes.imageAdded = diff.added;
          changes.imageRemoved = diff.removed;
        } catch (e) {
          if (signal.aborted) throw e;
          changes.imageComparison = "UNAVAILABLE";
          imageComparisonError =
            e instanceof Error ? e.message : "이미지 변화 비교 실패";
        }
      }
      signal.throwIfAborted();
      const g: Generation = {
        id: randomUUID(),
        parentId: previous?.id ?? null,
        generationNumber: number,
        number,
        article,
        headline: article.title,
        inputImage,
        generatedImage,
        imagePrompt,
        claims: article.body,
        claimOrigins: Object.fromEntries(
          article.body.map((c) => [c.id, c.origin!]),
        ),
        humanInterventions: recordedEdit,
        intervention: recordedEdit,
        demo: session.demo,
        seed,
        denoise,
        generationDuration: Date.now() - started,
        createdAt: new Date().toISOString(),
        automatic,
        changes,
        imageComparisonError,
        observedFacts: article.body
          .filter((c) => c.kind === "observation")
          .map((c) => c.text),
        inferredFacts: article.body
          .filter((c) => c.kind === "inference")
          .map((c) => c.text),
        inventedDetails: article.body
          .filter((c) => c.kind === "fiction")
          .map((c) => c.text),
        alternativeInterpretations: article.alternatives,
      };
      session.generations.push(g);
      await saveSession(session);
      if (imageComparisonError && automatic)
        throw Error(
          `이미지 비교 오류로 자동 재생산을 중단했습니다: ${imageComparisonError}`,
        );
    }
    job.status = "completed";
    job.phase = "완료";
  } catch (e) {
    if (task.promptId) {
      try {
        await cancelComfy(task.promptId);
      } catch (cancelError) {
        job.cancellationWarning =
          cancelError instanceof Error
            ? cancelError.message
            : "ComfyUI 중지 실패";
      }
    }
    if (signal.aborted) {
      job.status = "stopped";
      job.phase = "중지됨";
    } else {
      job.status = "failed";
      job.phase = "오류로 중단";
      job.error = e instanceof Error ? e.message : "생성 실패";
    }
  } finally {
    try {
      await saveSession(session);
    } catch (e) {
      job.status = "failed";
      job.error = `로컬 저장 실패: ${e instanceof Error ? e.message : e}`;
    } finally {
      if (running === task) running = null;
    }
  }
}
export async function stopJob(id: string) {
  const session = await getSession(id);
  if (!running || running.job.sessionId !== id) return session.job ?? null;
  const task = running;
  task.job.status = "stopping";
  task.job.phase = "중지 요청 처리 중";
  task.controller.abort();
  // The worker cancels only its own ComfyUI prompt, then releases the lock.
  await saveSession(session);
  return task.job;
}

export async function shutdownWorker() {
  if (running) {
    const task = running;
    task.controller.abort();
    await task.done;
  }
}
