import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { migrateGeneration } from "../src/domain.ts";
import type { Session } from "../src/domain.ts";
import { cancelComfy } from "./comfy.ts";
import { fail } from "./local.ts";
export const DATA = resolve(process.env.OVERHEARD_DATA_DIR || "data/sessions");
const sessions = new Map<string, Session>();
export function sessionId(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) fail("유효하지 않은 세션 ID입니다.");
  return id;
}
export function sessionDir(id: string) {
  return join(DATA, sessionId(id));
}
export async function saveSession(session: Session) {
  await mkdir(sessionDir(session.id), { recursive: true });
  const target = join(sessionDir(session.id), "session.json");
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(session, null, 2));
  await rename(temp, target);
  sessions.set(session.id, session);
}
export async function getSession(id: string): Promise<Session> {
  sessionId(id);
  const cached = sessions.get(id);
  if (cached) return cached;
  let data: Session;
  try {
    data = JSON.parse(
      await readFile(join(sessionDir(id), "session.json"), "utf8"),
    );
  } catch {
    fail("저장된 세션을 찾지 못했습니다.", 404);
  }
  data.generations = data.generations.map((g, i, all) =>
    migrateGeneration(g, all[i - 1]),
  );
  if (data.job && ["running", "stopping"].includes(data.job.status)) {
    if (data.job.comfyPromptId) {
      try {
        await cancelComfy(data.job.comfyPromptId);
      } catch (e) {
        data.job.cancellationWarning =
          e instanceof Error ? e.message : "이전 ComfyUI 작업 취소 실패";
      }
    }
    data.job.status = "stopped";
    data.job.phase = "서버 재시작으로 중단됨";
    data.job.error =
      "완료된 세대는 보존되었습니다. 다음 생성을 직접 시작하세요.";
    await saveSession(data);
  }
  sessions.set(id, data);
  return data;
}
export async function listSessions() {
  await mkdir(DATA, { recursive: true });
  const dirs = await readdir(DATA, { withFileTypes: true });
  const result = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || !/^[a-f0-9-]{36}$/.test(dir.name)) continue;
    try {
      const s = await getSession(dir.name);
      result.push({
        id: s.id,
        createdAt: s.createdAt,
        demo: s.demo,
        count: s.generations.length,
        title: s.generations.at(-1)?.article.title ?? "원본 기록",
      });
    } catch {
      /* Ignore incomplete or unrelated directories. */
    }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function decodeImage(value: unknown) {
  if (typeof value !== "string") fail("이미지 데이터가 필요합니다.");
  const match =
    /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match || value.length > 15 * 1024 * 1024)
    fail("10MB 이하 JPEG, PNG, WebP 이미지가 필요합니다.");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 10 * 1024 * 1024)
    fail("이미지 크기가 유효하지 않습니다.");
  const valid =
    match[1] === "image/png"
      ? buffer
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === "image/jpeg"
        ? buffer[0] === 255 && buffer[1] === 216
        : buffer.toString("ascii", 0, 4) === "RIFF" &&
          buffer.toString("ascii", 8, 12) === "WEBP";
  if (!valid) fail("이미지 파일 형식을 확인하세요.");
  return { buffer, mime: match[1], extension: match[1].split("/")[1] };
}
export async function writeAsset(id: string, name: string, buffer: Buffer) {
  if (!/^[a-zA-Z0-9._-]+\.(png|jpeg|jpg|webp|svg)$/.test(name))
    fail("파일 이름이 유효하지 않습니다.");
  await mkdir(sessionDir(id), { recursive: true });
  await writeFile(join(sessionDir(id), name), buffer);
  return `/api/media/${id}/${name}`;
}
export async function readAsset(id: string, url: string) {
  const prefix = `/api/media/${sessionId(id)}/`;
  if (!url.startsWith(prefix)) fail("다른 세션의 이미지는 사용할 수 없습니다.");
  const name = url.slice(prefix.length);
  if (!/^[a-zA-Z0-9._-]+\.(png|jpeg|jpg|webp|svg)$/.test(name))
    fail("파일 이름이 유효하지 않습니다.");
  const mime = name.endsWith(".svg")
    ? "image/svg+xml"
    : name.endsWith(".png")
      ? "image/png"
      : name.endsWith(".webp")
        ? "image/webp"
        : "image/jpeg";
  try {
    return { buffer: await readFile(join(sessionDir(id), name)), mime };
  } catch {
    fail("저장된 이미지를 찾을 수 없습니다.", 404);
  }
}
export async function createSession(
  image: unknown,
  transcript: unknown,
  demo = false,
) {
  if (
    typeof transcript !== "string" ||
    !transcript.trim() ||
    transcript.length > 12000
  )
    fail("녹취를 1~12,000자로 입력하세요.");
  const decoded = decodeImage(image);
  const id = randomUUID();
  const url = await writeAsset(
    id,
    `original.${decoded.extension}`,
    decoded.buffer,
  );
  const session: Session = {
    id,
    createdAt: new Date().toISOString(),
    original: { image: url, transcript },
    generations: [],
    demo,
  };
  await saveSession(session);
  return session;
}
