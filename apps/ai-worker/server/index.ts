import { randomUUID } from 'node:crypto';
import { adminRoutes, adminConfigured, isAdmin, requireAdminOrigin } from './admin.ts';
import { creativePost, shouldSkipPhoto } from './creative.ts';
import { DEFAULT_COVER_CONTEXT } from './editorial-rules.ts';
import { validatePublicationImage } from './publication-images.ts';
import { chatFetch, textModel, aiSettings, setClaudeEnabled } from './ai.ts';
import { publicImageRoute } from './publication-images.ts';
import { instagramRoutes } from './instagram.ts';
import { publicationRoutes, shutdownPublications } from "./publishing.ts";
import { newsRoutes } from "./news.ts";
import { transcribeAudio } from "./transcription.ts";
import { receiveTranscript, receivedTranscripts } from './transcripts.ts';
import { comfyStatus } from "./comfy.ts";
import {
  createSession,
  getSession,
  listSessions,
  readAsset,
  saveSession,
} from "./store.ts";
import { startJob, stopJob, activeJob, shutdownWorker } from "./engine.ts";
import { system } from "./prompts.ts";
import { createServer } from "node:http";
import { articleSchema, validateArticle, lineage } from "../src/domain.ts";
import type { Article, Intervention } from "../src/domain.ts";
const port = (value: string | undefined, fallback: number) =>
  value && /^\d+$/.test(value) && +value > 0 && +value < 65536
    ? +value
    : fallback;
const API_PORT = port(process.env.API_PORT, 3002);
const WHISPER = `http://127.0.0.1:${port(process.env.WHISPER_PORT, 8080)}`;

async function localFetch(url: string, init?: RequestInit, ms = 5000) {
  return fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(ms),
  });
}
function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
let previewBusy = false;
type PreviewResult = { caption: string; piezoLevel: number; cards: { title: string; body: string; image: string }[] };
type PreviewJob = { expires: number; status: 'generating' | 'completed' | 'failed'; result?: PreviewResult; error?: string };
const previews = new Map<string, PreviewJob>();
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const send = (data: unknown, status = 200) => {
    res.writeHead(status);
    res.end(JSON.stringify(data));
  };
  try {
    if (
      ![
        `localhost:${API_PORT}`,
        `127.0.0.1:${API_PORT}`,
        "localhost:5174",
        "127.0.0.1:5174",
      ].includes(req.headers.host ?? "")
    )
      fail("로컬 호스트만 허용합니다.", 403);
    if (
      req.headers.origin &&
      ![
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://localhost:3002",
        "http://127.0.0.1:3002",
        "http://localhost:4174",
        "http://127.0.0.1:4174",
        "https://n.joun.cc",
        ...(process.env.ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean),
      ].includes(req.headers.origin)
    )
      fail("허용되지 않은 요청입니다.", 403);
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === '/health' && req.method === 'GET') return send({ status: 'ok', service: 'ai-worker' });
    if (path === '/api/transcripts') {
      await receiveTranscript(req, res);
      return;
    }
    if (path === '/api/mobile/publications' || path.startsWith('/api/mobile/publications/')) {
      await publicationRoutes(req, res, path);
      return;
    }
    if (await publicImageRoute(req, res)) return;
    if (await newsRoutes(req, res, path)) return;
    const publicRequest =
      req.headers["x-overheard-public"] === "1" ||
      !!req.headers["cf-connecting-ip"] ||
      req.headers.origin === "https://n.joun.cc";
    if (path === '/api/received-transcripts' && req.method === 'GET') {
      if (publicRequest && !isAdmin(req)) fail('관리자 인증 후 수신 텍스트를 볼 수 있습니다.', 403);
      const items = await receivedTranscripts();
      return send({ item: items.at(-1) ?? null, items });
    }
    if (path === "/api/instagram/callback" && req.method === "GET") {
      res.setHeader("Referrer-Policy", "no-referrer");
      await instagramRoutes(req, res, publicRequest);
      return;
    }
    if (await adminRoutes(req, res, path)) return;
    const settingsView = () => ({ ...aiSettings(), editable: !publicRequest || isAdmin(req), requiresAdmin: publicRequest, adminAvailable: adminConfigured() });
    if (path === "/api/ai-settings") {
      if (req.method === "GET") return send(settingsView());
      if (req.method !== "POST") fail("허용되지 않은 메서드입니다.", 405);
      if (publicRequest) {
        requireAdminOrigin(req);
        if (!isAdmin(req)) fail("관리자 인증 후 전환할 수 있습니다.", 403);
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) fail("JSON 요청이 필요합니다.", 415);
      let raw = '';
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 1024) fail("입력이 너무 큽니다.", 413);
      }
      let value;
      try { value = JSON.parse(raw); } catch { fail("올바른 JSON 입력이 필요합니다."); }
      if (typeof value?.enabled !== 'boolean') fail("enabled는 불리언이어야 합니다.");
      setClaudeEnabled(value.enabled);
      return send(settingsView());
    }
    const previewId = /^\/api\/card-preview\/([a-f0-9-]{36})$/.exec(path);
    if (previewId && req.method === 'GET') {
      const job = previews.get(previewId[1]);
      if (!job || job.expires < Date.now()) fail('생성 결과가 만료되었습니다. 다시 생성해 주세요.', 404);
      return send({ status: job.status, result: job.result, error: job.error });
    }
    if (path === "/api/card-preview" && req.method === "POST") {
      if (!req.headers['content-type']?.startsWith('application/json')) fail('JSON 요청이 필요합니다.', 415);
      if (previewBusy) fail('다른 카드뉴스를 만들고 있습니다. 잠시 후 다시 시도하세요.', 409);
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 12 * 1024 * 1024) fail('사진 입력이 너무 큽니다.', 413);
        chunks.push(chunk);
      }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('올바른 JSON이 필요합니다.'); }
      validatePublicationImage(value?.image);
      if (![0, 1, 2].includes(value?.piezoLevel)) fail('피에조 단계는 0, 1, 2 중 하나입니다.');
      if (value.prompt !== undefined && (typeof value.prompt !== 'string' || value.prompt.length > 2000)) fail('맥락은 2,000자 이내입니다.');
      if (value.transcript !== undefined && (typeof value.transcript !== 'string' || value.transcript.length > 8000)) fail('녹취는 8,000자 이내의 텍스트여야 합니다.');
      if (previewBusy) fail('다른 카드뉴스를 만들고 있습니다. 잠시 후 다시 시도하세요.', 409);
      previewBusy = true;
      const generate = async (): Promise<PreviewResult> => {
        try {
          const signal = AbortSignal.timeout(360000);
          if (await shouldSkipPhoto(value.image, signal)) fail('초점·흔들림으로 피사체를 알아보기 어려워 카드뉴스 생성을 스킵했습니다.', 422);
          const result = await creativePost(value.image, value.prompt?.trim() || DEFAULT_COVER_CONTEXT, signal, async () => {}, async () => {}, value.piezoLevel, value.transcript || '');
          return { caption: result.caption, piezoLevel: value.piezoLevel, cards: result.cards.map((card, index) => ({ ...card, image: `data:image/jpeg;base64,${result.images[index].toString('base64')}` })) };
        } finally { previewBusy = false; }
      };
      if (req.headers.prefer === 'respond-async') {
        for (const [id, job] of previews) if (job.expires < Date.now()) previews.delete(id);
        while (previews.size >= 5) previews.delete(previews.keys().next().value!);
        const id = randomUUID();
        const job: PreviewJob = { status: 'generating', expires: Date.now() + 30 * 60 * 1000 };
        previews.set(id, job);
        void generate().then(result => { job.result = result; job.status = 'completed'; }).catch(error => {
          job.error = error instanceof Error ? error.message : '카드뉴스 생성에 실패했습니다.'; job.status = 'failed';
        });
        return send({ id, status: job.status }, 202);
      }
      return send(await generate());
    }
    const intake = req.method === "POST" && (path === "/api/observations" && !req.headers.origin || path === "/api/piezo");
    if (intake) {
      await publicationRoutes(req, res, path);
      return;
    }
    if (req.method === "GET" && /^\/api\/received-photos(?:\/[a-zA-Z0-9_-]{1,100})?$/.test(path)) {
      if (publicRequest && !isAdmin(req)) fail("관리자 인증 후 수신 사진을 볼 수 있습니다.", 403);
      await publicationRoutes(req, res, path);
      return;
    }
    const publishingRequest = path === "/api/publishing/piezo" || path === "/api/publishing/restart" || path === "/api/publishing/status" || path === "/api/creations" ||
      /^\/api\/observations(?:\/[a-zA-Z0-9_-]{1,100}(?:\/(?:generate|publish|image|cards\/[0-3]))?)?$/.test(path) ||
      ["/api/instagram/connect", "/api/instagram/complete", "/api/instagram/account"].includes(path);
    if (publicRequest && publishingRequest) {
      if (!isAdmin(req)) fail("관리자 인증 후 게시 기능을 사용할 수 있습니다.", 403);
      if (!["GET", "HEAD"].includes(req.method ?? "")) requireAdminOrigin(req);
      if (await instagramRoutes(req, res, publicRequest)) return;
      if (await publicationRoutes(req, res, path)) return;
    }
    if (
      publicRequest &&
      !["/api/status", "/api/generate", "/api/transcribe"].includes(path)
    )
      fail("공개 사이트에서는 저장된 자료에 접근할 수 없습니다.", 403);
    if (await instagramRoutes(req, res, publicRequest)) return;
    if (await publicationRoutes(req, res, path)) return;
    if (req.method === "GET" && req.url === "/api/status") {
      const [whisper, comfy] = await Promise.allSettled([
        localFetch(`${WHISPER}/health`).then((r) => r.ok),
        comfyStatus(),
      ]);
      return send({
        ollama: false,
        model: !!process.env.ANTHROPIC_API_KEY,
        whisper: whisper.status === "fulfilled" && whisper.value,
        modelName: textModel(),
        textProvider: "claude",
        ...(comfy.status === "fulfilled"
          ? comfy.value
          : { comfy: false, checkpoint: false }),
        activeJob: publicRequest ? null : activeJob(),
      });
    }
    const mediaMatch =
      /^\/api\/media\/([a-f0-9-]{36})\/([a-zA-Z0-9._-]+)$/.exec(path);
    if (req.method === "GET" && mediaMatch) {
      const asset = await readAsset(mediaMatch[1], path);
      res.setHeader("Content-Type", asset.mime);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
      res.writeHead(200);
      res.end(asset.buffer);
      return;
    }
    if (req.method === "GET" && path === "/api/sessions")
      return send({ sessions: await listSessions() });
    const sessionMatch =
      /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(run|stop|review))?$/.exec(path);
    if (req.method === "GET" && sessionMatch && !sessionMatch[2])
      return send(await getSession(sessionMatch[1]));
    if (
      req.method !== "POST" ||
      !(
        ["/api/generate", "/api/transcribe", "/api/sessions"].includes(path) ||
        sessionMatch?.[2]
      )
    )
      return send({ error: "Not found" }, 404);
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 16 * 1024 * 1024)
        fail("입력 크기는 16MB 이하로 제한됩니다.", 413);
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    if (req.url === "/api/transcribe") {
      if (!req.headers["content-type"]?.startsWith("audio/wav"))
        fail("WAV 오디오가 필요합니다.");
      return send(await transcribeAudio(raw, WHISPER));
    }

    let input;
    try {
      input = JSON.parse(raw.toString());
    } catch {
      fail("올바른 JSON 입력이 필요합니다.");
    }
    if (!input || typeof input !== "object") fail("JSON 객체가 필요합니다.");
    if (path === "/api/sessions")
      return send(
        await createSession(input.image, input.transcript, input.demo === true),
        201,
      );
    if (sessionMatch?.[2] === "run")
      return send(await startJob(sessionMatch[1], input), 202);
    if (sessionMatch?.[2] === "review") {
      const session = await getSession(sessionMatch[1]);
      if (
        !Number.isInteger(input.generation) ||
        !session.generations.some((g) => g.number === input.generation)
      )
        fail("완료된 세대만 검토 표시할 수 있습니다.");
      const reviewed = new Set(session.reviewedGenerations ?? []);
      if (input.reviewed === true) reviewed.add(input.generation);
      else reviewed.delete(input.generation);
      session.reviewedGenerations = [...reviewed];
      await saveSession(session);
      return send(session);
    }
    if (sessionMatch?.[2] === "stop")
      return send(await stopJob(sessionMatch[1]));
    const { image, transcript, previous, intervention, generation } = input;
    if (publicRequest && generation !== 1)
      fail("공개 사이트에서는 기사 한 편 생성만 제공합니다.", 403);
    if (!Number.isInteger(generation) || generation < 1 || generation > 30)
      fail("세대는 1~30 범위여야 합니다.");
    let content: string;
    if (generation === 1) {
      if (
        typeof image !== "string" ||
        !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)
      )
        fail("JPEG, PNG 또는 WebP 사진이 필요합니다.");
      if (
        typeof transcript !== "string" ||
        !transcript.trim() ||
        transcript.length > 12000
      )
        fail("녹취는 1~12,000자로 입력해 주세요.");
      content = JSON.stringify({
        task: "사진과 부분 녹취로 첫 허구적 기사 생성",
        transcript,
      });
    } else {
      validateArticle(previous);
      if (
        !previous.body.every(
          (c: { id: string; firstGeneration: number }) =>
            typeof c.id === "string" &&
            Number.isInteger(c.firstGeneration) &&
            c.firstGeneration >= 1 &&
            c.firstGeneration < generation,
        )
      )
        fail("이전 세대 출처가 유효하지 않습니다.");
      const edit = intervention as Intervention;
      if (
        !edit ||
        !Array.isArray(edit.deleted) ||
        !Array.isArray(edit.emphasized) ||
        ![...edit.deleted, ...edit.emphasized].every(
          (id) =>
            typeof id === "string" &&
            previous.body.some((c: { id: string }) => c.id === id),
        ) ||
        typeof edit.inserted !== "string" ||
        typeof edit.direction !== "string" ||
        edit.inserted.length > 2000 ||
        edit.direction.length > 1000
      )
        fail("개입 입력이 유효하지 않습니다.");
      const p = previous as Article;
      const editedBody = p.body
        .filter((c) => !edit.deleted.includes(c.id))
        .map((c) => ({ ...c, emphasized: edit.emphasized.includes(c.id) }));
      content = JSON.stringify({
        task: "직전 허구적 기사만 재보도. 삭제된 본문은 근거로 사용하지 말 것. 인간 삽입문도 미검증 자료다.",
        previous: { title: p.title, body: editedBody },
        humanInsertion: edit.inserted,
        direction: edit.direction,
      });
    }
    const response = await chatFetch(
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: textModel(),
          stream: false,
          format: articleSchema,
          options: { temperature: 0.8, num_predict: 3000 },
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content,
              ...(generation === 1 ? { images: [image.split(",")[1]] } : {}),
            },
          ],
        }),
      },
      240000,
    );
    const data = await response.json();
    let article;
    try {
      article = JSON.parse(data.message?.content);
      validateArticle(article);
    } catch {
      fail("모델의 JSON 응답이 유효하지 않습니다. 다시 생성해 주세요.", 502);
    }
    article.title = article.title.includes("[허구]")
      ? article.title
      : `[허구] ${article.title}`;
    const quoteSource =
      generation === 1
        ? transcript
        : previous.body
            .filter((c: { id: string }) => !intervention.deleted.includes(c.id))
            .map((c: { text: string }) => c.text)
            .join("\n");
    article.quotes = article.quotes.filter(
      (quote: string) => quote.trim() && quoteSource.includes(quote),
    );
    const sourceArticle =
      generation > 1
        ? {
            ...previous,
            body: previous.body.filter(
              (c: { id: string }) => !intervention.deleted.includes(c.id),
            ),
          }
        : undefined;
    send({ article: lineage(article, generation, sourceArticle) });
  } catch (error) {
    const e = error as Error & { status?: number };
    if (res.writableEnded) { console.error("Post-response processing failed"); return; }
    send(
      { error: e.message || "로컬 처리 중 오류가 발생했습니다." },
      e.status ?? 500,
    );
  }
});
server.listen(API_PORT, process.env.API_HOST || "127.0.0.1", () =>
  console.log(`THE OVERHEARD local API: http://127.0.0.1:${API_PORT}`),
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 12000);
  deadline.unref();
  await shutdownPublications();
  await shutdownWorker();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
