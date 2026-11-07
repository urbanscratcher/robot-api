import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inspectWav, transcribeAudio } from "./transcription.ts";
function wav(silent = false) {
  const b = Buffer.alloc(44 + 32000);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(32000, 40);
  if (!silent)
    for (let p = 44; p < b.length; p += 2)
      b.writeInt16LE(Math.round(Math.sin((p - 44) * 0.04) * 3000), p);
  return b;
}
test("validate recorded PCM and reject truncated files", () => {
  assert.equal(inspectWav(wav()).duration, 1);
  assert.ok(inspectWav(wav()).rms > 0.01);
  assert.equal(inspectWav(wav(true)).rms, 0);
  assert.throws(() => inspectWav(Buffer.from("bad")));
  assert.throws(() => inspectWav(wav().subarray(0, 80)));
});
test("Korean verbatim transcription: real audio payload, deterministic settings and no placeholder segments", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const form = await new Request("http://localhost/inference", {
      method: "POST",
      headers: { "Content-Type": req.headers["content-type"]! },
      body: raw,
    }).formData();
    assert.equal(form.get("language"), "ko");
    assert.equal(form.get("translate"), "false");
    assert.equal(form.get("temperature"), "0.0");
    assert.equal(form.get("temperature_inc"), "0.0");
    assert.equal(form.get("beam_size"), "5");
    assert.equal(form.get("response_format"), "verbose_json");
    assert.deepEqual(
      Buffer.from(await (form.get("file") as File).arrayBuffer()),
      wav(),
    );
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        text: "오늘 오후 세 시에 만나자. [기록되지 않음]",
        segments: [
          { start: 0, end: 0.5, text: " 오늘 오후 세 시에 만나자. " },
          { start: 0.5, end: 1, text: "[음성 인식 없음]" },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const silence = await transcribeAudio(wav(true), url);
    assert.equal(silence.text, "");
    assert.deepEqual(silence.segments, []);
    assert.equal(calls, 0);
    const result = await transcribeAudio(wav(), url);
    assert.equal(result.text, "오늘 오후 세 시에 만나자.");
    assert.deepEqual(result.segments, [
      { start: 0, end: 0.5, text: "오늘 오후 세 시에 만나자." },
    ]);
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
