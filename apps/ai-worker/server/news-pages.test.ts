import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/editions/news.js', import.meta.url), 'utf8');
test('edition renderer handles empty, one and many articles, escapes text and preserves deep links', async () => {
  for (const slug of ['elle', 'vogue', 'chosun', 'donga', 'kyunghyang', 'time', 'newyorker', 'atlantic', 'natgeo', 'wired']) {
    const html = await readFile(new URL(`../public/editions/${slug}.html`, import.meta.url), 'utf8');
    const edition = JSON.parse(/<script id="edition" type="application\/json">(.*?)<\/script>/.exec(html)![1]);
    assert.ok(html.includes('/editions/news.js'));
    const app = { innerHTML: '' };
    const location = { pathname: `/${slug}`, hash: '' };
    const listeners: Record<string, () => void> = {};
    const events: Record<string, () => void> = {};
    const photo = { id: 'old', title: '<img onerror=alert(1)>', caption: '본문\n<script>alert(1)</script>', images: ['/api/news/old/images/0'], publishedAt: '2026-11-06T11:29:00+09:00' };
    let items: typeof photo[] = [];
    const context = {
      document: { querySelector: (s: string) => s === '#edition' ? { textContent: JSON.stringify(edition) } : s === '#app' ? app : {}, body: { className: '' }, head: { append() {} }, createElement: () => ({}) },
      location, window: { addEventListener: (name: string, fn: () => void) => { listeners[name] = fn; }, scrollTo() {} },
      fetch: async () => ({ ok: true, json: async () => ({ items }) }), AbortSignal, setInterval() {},
      EventSource: class {
        constructor(url: string) { assert.equal(url, '/api/news/events'); }
        addEventListener(name: string, fn: () => void) { events[name] = fn; }
      },
    };
    runInNewContext(source, context);
    await new Promise(r => setImmediate(r));
    assert.match(app.innerHTML, /아직 게시된 기사가 없습니다/);
    assert.match(app.innerHTML, /class="sponsor-ad"/);
    assert.match(app.innerHTML, /https:\/\/drive\.google\.com\/thumbnail\?id=/);
    assert.match(app.innerHTML, /rel="noopener noreferrer sponsored"/);
    assert.match(app.innerHTML, /target="_blank"/);
    items = [photo];
    events.published(); await new Promise(r => setImmediate(r));
    assert.match(app.innerHTML, /&lt;img onerror=alert\(1\)&gt;/);
    assert.ok(!app.innerHTML.includes('<script>alert'));
    assert.ok(!app.innerHTML.includes('undefined'));
    location.hash = '#article/old'; listeners.hashchange();
    assert.match(app.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    items = [photo, { ...photo, id: 'new', title: '가장 최신 헤드라인', publishedAt: '2026-11-06T03:37:00Z' }];
    listeners.online(); await new Promise(r => setImmediate(r));
    assert.match(app.innerHTML, /src="\/api\/news\/old\/images\/0"/);
    location.hash = ''; listeners.hashchange();
    assert.match(app.innerHTML, /<h1><a href="#article\/new">가장 최신 헤드라인<\/a><\/h1>/);
    location.hash = '#article/missing'; listeners.hashchange();
    assert.match(app.innerHTML, /기사를 찾을 수 없습니다/);
    location.hash = '#screen'; listeners.hashchange();
    assert.match(context.document.body.className, / display$/);
  }
});
