import { readFile } from "node:fs/promises";
import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { COMFY, localFetch, fail } from "./local.ts";
const CHECKPOINT = "sd_xl_base_1.0.safetensors";
type ComfyFile = { filename: string; subfolder: string; type: string };
type Graph = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;
export async function comfyStatus() {
  try {
    const r = await localFetch(`${COMFY}/object_info`);
    if (!r.ok) throw Error();
    const nodes = await r.json();
    const graph = JSON.parse(
      await readFile(
        new URL("./workflows/sdxl-img2img.json", import.meta.url),
        "utf8",
      ),
    ) as Graph;
    const missing = Object.values(graph)
      .filter((n) => !nodes[n.class_type])
      .map((n) => n.class_type);
    const models =
      nodes.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    const sampler = nodes.KSampler?.input?.required;
    const compatible =
      missing.length === 0 &&
      sampler?.sampler_name?.[0]?.includes("dpmpp_2m") &&
      sampler?.scheduler?.[0]?.includes("karras");
    return {
      comfy: true,
      checkpoint: models.includes(CHECKPOINT),
      comfyCompatible: !!compatible,
      comfyError: missing.length
        ? `누락 노드: ${missing.join(", ")}`
        : !compatible
          ? "샘플러 또는 스케줄러 불일치"
          : !models.includes(CHECKPOINT)
            ? `${CHECKPOINT} 미설치`
            : "",
    };
  } catch {
    return {
      comfy: false,
      checkpoint: false,
      comfyCompatible: false,
      comfyError: "ComfyUI 127.0.0.1:8188 연결 실패",
    };
  }
}
export async function cancelComfy(promptId: string) {
  // Target only this application's prompt. Never issue a global interrupt.
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  const result = await localFetch(
    `${COMFY}/api/jobs/${encodeURIComponent(promptId)}/cancel`,
    options,
  );
  if (result.ok) return;
  if (result.status !== 404)
    throw Error(`ComfyUI 취소 실패 (${result.status})`);
  const [queued, interrupt] = await Promise.all([
    localFetch(`${COMFY}/queue`, {
      ...options,
      body: JSON.stringify({ delete: [promptId] }),
    }),
    localFetch(`${COMFY}/interrupt`, {
      ...options,
      body: JSON.stringify({ prompt_id: promptId }),
    }),
  ]);
  if (!queued.ok || !interrupt.ok)
    throw Error("ComfyUI에 중지 요청을 전달하지 못했습니다.");
}
export async function generateImage(
  image: Buffer,
  mime: string,
  prompt: string,
  signal: AbortSignal,
  onPrompt: (id: string) => Promise<void>,
  denoise = 0.45,
) {
  const state = await comfyStatus();
  if (!state.comfy || !state.checkpoint || !state.comfyCompatible)
    fail(state.comfyError, 503);
  signal.throwIfAborted();
  const name = `overheard-${randomUUID()}.${mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"}`;
  const form = new FormData();
  form.append("image", new Blob([image], { type: mime }), name);
  form.append("type", "input");
  form.append("subfolder", "THE_OVERHEARD");
  const uploaded = await localFetch(
    `${COMFY}/upload/image`,
    { method: "POST", body: form },
    30000,
    signal,
  );
  if (!uploaded.ok)
    fail(`ComfyUI 이미지 업로드 실패 (${uploaded.status})`, 502);
  const file = await uploaded.json();
  if (typeof file.name !== "string")
    fail("ComfyUI 업로드 응답이 유효하지 않습니다.", 502);
  const graph = JSON.parse(
    await readFile(
      new URL("./workflows/sdxl-img2img.json", import.meta.url),
      "utf8",
    ),
  ) as Graph;
  const seed = randomInt(2 ** 48 - 1);
  graph["2"].inputs.image = file.subfolder
    ? `${file.subfolder}/${file.name}`
    : file.name;
  graph["5"].inputs.text = prompt;
  graph["7"].inputs.seed = seed;
  graph["7"].inputs.denoise = denoise;
  const requestedId = randomUUID();
  await onPrompt(requestedId);
  const queued = await localFetch(
    `${COMFY}/prompt`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: graph,
        prompt_id: requestedId,
        client_id: "THE_OVERHEARD",
      }),
    },
    30000,
    signal,
  );
  if (!queued.ok)
    fail(`ComfyUI 워크플로 오류: ${(await queued.text()).slice(0, 1000)}`, 502);
  const job = await queued.json();
  if (typeof job.prompt_id !== "string")
    fail("ComfyUI prompt_id가 없습니다.", 502);
  await onPrompt(job.prompt_id);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await localFetch(
      `${COMFY}/history/${encodeURIComponent(job.prompt_id)}`,
      {},
      10000,
      signal,
    );
    if (!result.ok) fail("ComfyUI 생성 기록을 읽지 못했습니다.", 502);
    const entry = (await result.json())[job.prompt_id];
    if (entry?.status?.status_str === "error") {
      const detail = entry.status.messages?.find(
        (m: unknown[]) => m[0] === "execution_error",
      )?.[1];
      fail(
        `ComfyUI 생성 실패: ${detail?.exception_message ?? "실행 로그를 확인하세요."}`,
        502,
      );
    }
    const output = entry?.outputs?.["9"]?.images?.[0] as ComfyFile | undefined;
    if (output) {
      const qs = new URLSearchParams({
        filename: output.filename,
        subfolder: output.subfolder ?? "",
        type: output.type ?? "output",
      });
      const response = await localFetch(
        `${COMFY}/view?${qs}`,
        {},
        30000,
        signal,
      );
      if (!response.ok) fail("ComfyUI 결과 이미지를 읽지 못했습니다.", 502);
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        seed,
        denoise,
        promptId: job.prompt_id,
        workflow: graph,
      };
    }
    if (entry?.status?.completed)
      fail("ComfyUI가 결과 이미지 없이 완료되었습니다.", 502);
    await delay(1000, undefined, { signal });
  }
  fail("ComfyUI 생성이 10분을 초과했습니다.", 504);
}
