import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=",
  "base64",
);
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as { port: number }).port;
}
test("recursive worker: images, lineage, edits, limits, isolated cancellation and persistence", async () => {
  let mode = "ok";
  const prompts: any[] = [];
  const uploads: Buffer[] = [];
  const interpretations: any[] = [];
  const cancellations: string[] = [];
  const promptIds: string[] = [];
  const comfy = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/json");
    const send = (v: unknown) => res.end(JSON.stringify(v));
    if (path === "/object_info") {
      const names = [
        "CheckpointLoaderSimple",
        "LoadImage",
        "ImageScaleToMaxDimension",
        "VAEEncode",
        "CLIPTextEncode",
        "KSampler",
        "VAEDecode",
        "SaveImage",
      ];
      return send(
        Object.fromEntries(
          names.map((name) => [
            name,
            {
              input: {
                required:
                  name === "CheckpointLoaderSimple"
                    ? { ckpt_name: [["sd_xl_base_1.0.safetensors"]] }
                    : name === "KSampler"
                      ? {
                          sampler_name: [["dpmpp_2m"]],
                          scheduler: [["karras"]],
                        }
                      : {},
              },
            },
          ]),
        ),
      );
    }
    if (path === "/upload/image") {
      uploads.push(raw);
      return send({ name: "input.png", subfolder: "THE_OVERHEARD" });
    }
    if (path === "/prompt") {
      const data = JSON.parse(raw.toString());
      prompts.push(data.prompt);
      promptIds.push(data.prompt_id);
      return send({ prompt_id: data.prompt_id });
    }
    if (path.startsWith("/history/")) {
      const id = path.split("/").at(-1)!;
      if (mode === "hold") return send({});
      if (mode === "error")
        return send({
          [id]: {
            status: {
              status_str: "error",
              messages: [
                ["execution_error", { exception_message: "test failure" }],
              ],
            },
          },
        });
      return send({
        [id]: {
          status: { status_str: "success", completed: true },
          outputs: {
            "9": {
              images: [
                { filename: `${id}.png`, type: "output", subfolder: "" },
              ],
            },
          },
        },
      });
    }
    if (path === "/view") {
      res.setHeader("Content-Type", "image/png");
      return res.end(
        Buffer.concat([png, Buffer.from(`OUTPUT-${prompts.length}`)]),
      );
    }
    if (path.startsWith("/api/jobs/") && path.endsWith("/cancel")) {
      cancellations.push(path.split("/")[3]);
      return send({ cancelled: true });
    }
    res.writeHead(404);
    send({ error: "unknown" });
  });
  const ollama = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags")
      return res.end(JSON.stringify({ models: [{ name: "gemma3:4b" }] }));
    const data = JSON.parse(raw);
    if (data.messages[1].images.length === 2 && mode === "compareError") {
      res.writeHead(500);
      return res.end("{}");
    }
    if (data.messages[1].images.length === 2)
      return res.end(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              added: ["붉은 봉투"],
              removed: ["빈 공간"],
            }),
          },
        }),
      );
    interpretations.push(data);
    const input = JSON.parse(data.messages[1].content);
    const parent = input.previous?.body?.[0]?.id;
    const human = !!input.humanInsertion;
    const article = {
      title: "[허구] 재귀 기사",
      summary: "허구의 재구성이다.",
      situation: "미검증 해석",
      imagePrompt:
        "Anonymous silhouettes in a fictional meeting room, documentary lighting, no text",
      body: [
        {
          text: "같은 의미를 바꿔 쓴 주장",
          kind: "observation",
          sourceIds: parent ? [parent] : [],
          relation: parent ? "inherited" : "new",
        },
        {
          text: human ? input.humanInsertion : "새로운 추측",
          kind: "inference",
          sourceIds: [],
          relation: human ? "human" : "new",
        },
        {
          text: "가상의 사건 전개",
          kind: "fiction",
          sourceIds: [],
          relation: "new",
        },
      ],
      quotes: [],
      alternatives: ["일상", "연극"],
    };
    res.end(JSON.stringify({ message: { content: JSON.stringify(article) } }));
  });
  const comfyPort = await listen(comfy),
    ollamaPort = await listen(ollama);
  const probe = createServer();
  const apiPort = await listen(probe);
  await new Promise<void>((r) => probe.close(() => r()));
  const dataDir = await mkdtemp(join(tmpdir(), "overheard-test-"));
  let child: ReturnType<typeof spawn>;
  async function boot() {
    child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--import", "./server/fixtures/claude-mock.ts", "server/index.ts"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          API_PORT: String(apiPort),
          COMFY_PORT: String(comfyPort),
          ANTHROPIC_API_KEY: 'synthetic-test-key', CLAUDE_FIXTURE_PORT: String(ollamaPort),
          OLLAMA_PORT: String(ollamaPort),
          OVERHEARD_DATA_DIR: dataDir,
        },
      },
    );
    await Promise.race([
      once(child.stdout!, "data"),
      once(child, "exit").then(() => {
        throw Error("server failed");
      }),
    ]);
  }
  async function call(path: string, body?: unknown) {
    const r = await fetch(
      `http://127.0.0.1:${apiPort}/api${path}`,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    return { status: r.status, data: await r.json() };
  }
  async function waitFor(id: string, predicate: (s: any) => boolean) {
    for (let i = 0; i < 250; i++) {
      const { data } = await call("/sessions/" + id);
      if (predicate(data)) return data;
      await delay(20);
    }
    throw Error("poll timed out");
  }
  try {
    await boot();
    const first = (
      await call("/sessions", {
        image: `data:image/png;base64,${png.toString("base64")}`,
        transcript: "ORIGINAL_ONLY_TRANSCRIPT",
      })
    ).data;
    assert.equal(first.generations.length, 0);
    assert.equal(
      (
        await call(`/sessions/${first.id}/run`, {
          mode: "auto",
          maxGenerations: 2,
        })
      ).status,
      202,
    );
    let s = await waitFor(first.id, (s) => s.job.status === "completed");
    assert.equal(s.generations.length, 2);
    assert.equal(interpretations.length, 2);
    assert.ok(
      interpretations[0].messages[1].content.includes(
        "ORIGINAL_ONLY_TRANSCRIPT",
      ),
    );
    assert.ok(
      !interpretations[1].messages[1].content.includes(
        "ORIGINAL_ONLY_TRANSCRIPT",
      ),
    );
    assert.notEqual(
      interpretations[0].messages[1].images[0],
      interpretations[1].messages[1].images[0],
    );
    assert.ok(
      Buffer.from(interpretations[1].messages[1].images[0], "base64")
        .toString()
        .includes("OUTPUT-1"),
    );
    assert.equal(s.generations[1].inputImage, s.generations[0].generatedImage);
    assert.equal(s.generations[1].parentId, s.generations[0].id);
    assert.equal(s.generations[1].claims[0].origin, "INHERITED_AI_CLAIM");
    assert.equal(s.generations[1].claims[0].kind, "inference");
    assert.equal(s.generations[1].claims[0].firstGeneration, 1);
    assert.deepEqual(s.generations[1].changes.imageAdded, ["붉은 봉투"]);
    assert.ok(s.generations.every((g: any) => g.automatic));
    assert.equal(prompts[0]["7"].inputs.steps, 20);
    assert.equal(prompts[0]["7"].inputs.cfg, 6.5);
    assert.equal(prompts[0]["7"].inputs.denoise, 0.45);
    assert.equal(prompts[0]["7"].inputs.sampler_name, "dpmpp_2m");
    const previous = s.generations[1];
    const replacement = Buffer.concat([png, Buffer.from("HUMAN_REPLACEMENT")]);
    assert.equal(
      (
        await call(`/sessions/${s.id}/run`, {
          mode: "human",
          intervention: {
            deleted: [previous.article.body[0].id],
            emphasized: [previous.article.body[1].id],
            inserted: "관객의 새 문장",
            direction: "일상으로",
            imagePrompt: "An empty stage with a red envelope",
            replacementImage: `data:image/png;base64,${replacement.toString("base64")}`,
          },
        })
      ).status,
      202,
    );
    s = await waitFor(
      s.id,
      (s) => s.job.status === "completed" && s.generations.length === 3,
    );
    const humanInput = JSON.parse(interpretations[2].messages[1].content);
    assert.ok(
      !humanInput.previous.body.some(
        (c: any) => c.id === previous.article.body[0].id,
      ),
    );
    assert.equal(humanInput.previous.body[0].emphasized, true);
    assert.equal(humanInput.previous.interpretation, undefined);
    assert.equal(humanInput.humanInsertion, "관객의 새 문장");
    assert.equal(
      prompts[2]["5"].inputs.text,
      "An empty stage with a red envelope",
    );
    assert.ok(uploads[2].includes(Buffer.from("HUMAN_REPLACEMENT")));
    assert.equal(s.generations[2].claims[1].origin, "HUMAN_INTERVENTION");
    assert.match(
      s.generations[2].humanInterventions.replacementImage,
      /g3-human/,
    );
    assert.equal(
      (
        await call(`/sessions/${s.id}/review`, {
          generation: 2,
          reviewed: true,
        })
      ).status,
      200,
    );
    mode = "hold";
    await call(`/sessions/${s.id}/run`, { mode: "auto", maxGenerations: 5 });
    await waitFor(s.id, (s) => s.job.phase.includes("COMFYUI"));
    while (promptIds.length < 4) await delay(10);
    assert.equal((await call(`/sessions/${s.id}/run`, {})).status, 409);
    await call(`/sessions/${s.id}/stop`, {});
    s = await waitFor(s.id, (s) => s.job.status === "stopped");
    assert.equal(s.generations.length, 3);
    assert.deepEqual(cancellations, [promptIds[3]]);
    mode = "error";
    await call(`/sessions/${s.id}/run`, { mode: "auto", maxGenerations: 5 });
    s = await waitFor(s.id, (s) => s.job.status === "failed");
    assert.equal(s.generations.length, 3);
    assert.match(s.job.error, /test failure/);
    mode = "compareError";
    await call(`/sessions/${s.id}/run`, { mode: "auto", maxGenerations: 5 });
    s = await waitFor(s.id, (s) => s.job.status === "failed");
    assert.equal(s.generations.length, 4);
    assert.equal(s.generations[3].changes.imageComparison, "UNAVAILABLE");
    assert.match(s.job.error, /이미지 비교 오류/);
    mode = "hold";
    const expectedPrompts = promptIds.length + 1;
    await call(`/sessions/${s.id}/run`, { mode: "auto", maxGenerations: 5 });
    await waitFor(s.id, (s) => !!s.job.comfyPromptId);
    while (promptIds.length < expectedPrompts) await delay(10);
    const interruptedPrompt = promptIds.at(-1);
    child!.kill("SIGKILL");
    await once(child!, "exit");
    await boot();
    const restored = (await call(`/sessions/${s.id}`)).data;
    assert.equal(restored.generations.length, 4);
    assert.equal(restored.job.status, "stopped");
    assert.equal(cancellations.at(-1), interruptedPrompt);
    assert.deepEqual(restored.reviewedGenerations, [2]);
    assert.equal(restored.original.transcript, "ORIGINAL_ONLY_TRANSCRIPT");
    assert.equal((await call("/sessions")).data.sessions.length, 1);
    const imageResponse = await fetch(
      `http://127.0.0.1:${apiPort}${restored.generations[0].generatedImage}`,
    );
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get("content-type"), "image/png");
  } finally {
    if (child! && child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    await Promise.all([
      new Promise<void>((r) => comfy.close(() => r())),
      new Promise<void>((r) => ollama.close(() => r())),
    ]);
    await rm(dataDir, { recursive: true, force: true });
  }
});
