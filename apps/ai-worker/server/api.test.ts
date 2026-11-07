import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("local API: multimodal generation, intervention, isolation and upstream failures", async () => {
  let mode = "ok";
  let captured: any;
  const response = {
    title: "시험 기사",
    summary: "추측이다",
    situation: "추측 상황",
    body: [
      { text: "관찰", kind: "observation", sourceIds: [] },
      { text: "추론", kind: "inference", sourceIds: [] },
      { text: "창작", kind: "fiction", sourceIds: [] },
    ],
    quotes: ["없는 대화"],
    alternatives: ["A", "B"],
  };
  const mock = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: "gemma3:4b" }] }));
      return;
    }
    captured = JSON.parse(data);
    if (mode === "missing") {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    res.end(
      JSON.stringify({
        message: {
          content: mode === "bad" ? "garbage" : JSON.stringify(response),
        },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(0, "127.0.0.1", resolve);
  });
  const mockPort = (mock.address() as { port: number }).port;
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const apiPort = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./server/fixtures/claude-mock.ts", "server/index.ts"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        API_PORT: String(apiPort),
        ANTHROPIC_API_KEY: 'synthetic-test-key', CLAUDE_FIXTURE_PORT: String(mockPort),
        OLLAMA_PORT: String(mockPort),
      },
    },
  );
  try {
    await Promise.race([
      once(child.stdout!, "data"),
      once(child, "exit").then(() => {
        throw Error("API failed to start");
      }),
    ]);
    const call = async (body: unknown, origin?: string) => {
      const r = await fetch(`http://127.0.0.1:${apiPort}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, data: await r.json() };
    };
    const first = {
      generation: 1,
      image: "data:image/jpeg;base64,YWJj",
      transcript: "[00:03] test",
    };
    const initial = await call(first);
    assert.equal(initial.status, 200);
    assert.deepEqual(captured.messages[1].images, ["YWJj"]);
    assert.equal(captured.stream, false);
    assert.equal(captured.model, "gemma3:4b");
    assert.equal(captured.format.type, "object");
    assert.match(initial.data.article.title, /^\[허구\]/);
    assert.deepEqual(initial.data.article.quotes, []);
    const published = await call(first, "https://n.joun.cc");
    assert.equal(published.status, 200);
    const blockedArchive = await fetch(
      `http://127.0.0.1:${apiPort}/api/sessions`,
      { headers: { "X-Overheard-Public": "1" } },
    );
    assert.equal(blockedArchive.status, 403);
    const blockedFile = await fetch(
      `http://127.0.0.1:${apiPort}/api/media/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/original.png`,
      { headers: { "CF-Connecting-IP": "192.0.2.1" } },
    );
    assert.equal(blockedFile.status, 403);
    const blockedReview = await fetch(
      `http://127.0.0.1:${apiPort}/api/observations`,
      { headers: { "X-Overheard-Public": "1" } },
    );
    assert.equal(blockedReview.status, 403);
    const blockedIntake = await fetch(
      `http://127.0.0.1:${apiPort}/api/observations`,
      { method: "POST", headers: { "X-Overheard-Public": "1", "Content-Type": "application/json" }, body: "{}" },
    );
    assert.equal(blockedIntake.status, 401);
    const publicCallback = await fetch(`http://127.0.0.1:${apiPort}/api/instagram/callback?state=invalid`, { headers: { "X-Overheard-Public": "1" } });
    assert.equal(publicCallback.status, 400);
    const publicNews = await fetch(`http://127.0.0.1:${apiPort}/api/news`, { headers: { "X-Overheard-Public": "1" } });
    assert.equal(publicNews.status, 200);
    assert.ok(Array.isArray((await publicNews.json()).items));
    for (const path of ['/api/received-photos', '/api/received-photos/camera-1']) {
      const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, { headers: { "X-Overheard-Public": "1" } });
      assert.equal(response.status, 403, '수신 사진은 관리자 인증이 필요합니다.');
    }
    const privateDrafts = await fetch(`http://127.0.0.1:${apiPort}/api/observations`, { headers: { "X-Overheard-Public": "1" } });
    assert.equal(privateDrafts.status, 403);
    const publicConnect = await fetch(`http://127.0.0.1:${apiPort}/api/instagram/connect`, { method: "POST", headers: { "X-Overheard-Public": "1", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(publicConnect.status, 403);
    const publicCreation = await fetch(`http://127.0.0.1:${apiPort}/api/creations`, { method: "POST", headers: { "X-Overheard-Public": "1", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(publicCreation.status, 403);
    const previous = initial.data.article;
    const edit = {
      deleted: ["g1-c1"],
      emphasized: ["g1-c2"],
      inserted: "관객 문장",
      direction: "진정해",
    };
    response.body[0].sourceIds = ["g1-c1", "g1-c2"];
    const second = await call({ generation: 2, previous, intervention: edit });
    assert.equal(second.status, 200);
    assert.deepEqual(second.data.article.body[0].sourceIds, ["g1-c2"]);
    assert.equal(captured.messages[1].images, undefined);
    const input = JSON.parse(captured.messages[1].content);
    assert.equal(input.previous.body.length, 2);
    assert.equal(input.previous.body[0].emphasized, true);
    assert.equal(input.humanInsertion, "관객 문장");
    assert.equal(input.direction, "진정해");
    assert.equal(input.transcript, undefined);
    assert.equal(input.previous.summary, undefined);
    assert.equal(second.data.article.body[0].kind, "inference");
    assert.equal((await call(first, "https://evil.example")).status, 403);
    assert.equal(
      (await call({ ...first, image: "https://external.example/photo.jpg" }))
        .status,
      400,
    );
    mode = "missing";
    assert.equal((await call(first)).status, 502);
    mode = "bad";
    assert.equal((await call(first)).status, 502);
  } finally {
    child.kill();
    await once(child, "exit");
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }
});
