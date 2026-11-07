import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Claude is mandatory despite legacy settings and never falls back on missing keys or upstream failures', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-settings-'));
  process.env.AI_SETTINGS_FILE = join(dir, 'settings.json');
  process.env.TEXT_PROVIDER = 'ollama';
  delete process.env.ANTHROPIC_API_KEY;
  const ai = await import('./ai.ts');
  try {
    await writeFile(process.env.AI_SETTINGS_FILE!, JSON.stringify({ enabled: false }));
    assert.equal(ai.usesClaude(), true);
    assert.equal(ai.aiSettings().locked, true);
    assert.equal(ai.aiSettings().configured, false);
    assert.throws(() => ai.setClaudeEnabled(false), /Claude API 전용/);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('Must not contact a local model'); });
    await assert.rejects(ai.chatFetch(), /ANTHROPIC_API_KEY/);
    assert.equal(calls, 0);
    t.mock.restoreAll();
    process.env.ANTHROPIC_API_KEY = 'test-secret';
    assert.equal(ai.setClaudeEnabled(true).enabled, true);
    process.env.TEXT_PROVIDER = 'ollama';
    assert.equal(ai.usesClaude(), true);
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.messages[0].content[0].source.media_type, 'image/png');
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"caption":"hello"}' }] });
    });
    const response = await ai.chatFetch({ body: JSON.stringify({ format: {}, messages: [{ role: 'user', content: 'hello', images: ['iVBORw0KGgo='] }] }) });
    assert.equal((await response.json()).message.content, '{"caption":"hello"}');
    t.mock.restoreAll();
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'test-secret' }, { status: 401 }));
    await assert.rejects(ai.chatFetch({ body: JSON.stringify({ messages: [], format: {} }) }), error => error instanceof Error && error.message.includes('401') && !error.message.includes('test-secret'));
    assert.equal(JSON.stringify(ai.aiSettings()).includes('test-secret'), false);
    t.mock.restoreAll();
    let networkCalls = 0;
    t.mock.method(globalThis, 'fetch', async url => {
      networkCalls++; assert.equal(url, 'https://api.anthropic.com/v1/messages');
      throw Error('synthetic network failure');
    });
    await assert.rejects(ai.chatFetch({ body: JSON.stringify({ messages: [], format: {} }) }), /Claude 연결 실패/);
    assert.equal(networkCalls, 1);

    t.mock.restoreAll();
    t.mock.method(globalThis, 'fetch', async () => new Response('invalid payload test-secret', { status: 200 }));
    await assert.rejects(ai.chatFetch({ body: JSON.stringify({ messages: [], format: {} }) }), error => error instanceof Error && !error.message.includes('test-secret'));
    t.mock.restoreAll();
    t.mock.method(globalThis, 'fetch', async () => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"caption":"test-secret"}' }] }));
    const redacted = await ai.chatFetch({ body: JSON.stringify({ messages: [], format: {} }) });
    assert.equal(JSON.stringify(await redacted.json()).includes('test-secret'), false);
    assert.throws(() => ai.setClaudeEnabled(false), /Claude API 전용/);
    assert.equal(ai.usesClaude(), true);
  } finally { t.mock.restoreAll(); await rm(dir, { recursive: true, force: true }); }
});
