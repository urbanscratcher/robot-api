const edition = JSON.parse(document.querySelector('#edition').textContent);
const app = document.querySelector('#app');
const editions = { elle: 'ELLE', vogue: 'VOGUE', chosun: '조선', donga: '동아', kyunghyang: '경향', time: 'TIME', newyorker: 'NEW YORKER', atlantic: 'ATLANTIC', natgeo: 'NAT GEO', wired: 'WIRED' };
const slug = location.pathname.startsWith('/editions/') ? location.pathname.split('/').pop().replace('.html', '') : location.pathname.split('/')[1];
const mast = ['time', 'newyorker', 'atlantic', 'natgeo', 'wired'].includes(slug) ? '해커톤일보' : 'PAPARAZZI BOT';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let stories = [], loaded = false, error = '', fetching = false, refreshPending = false;
const href = story => '#article/' + encodeURIComponent(story.id);
const date = story => escape(new Date(story.publishedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));
const summary = story => escape(story.caption.replaceAll('\n', ' ').slice(0, 140));
function art(story, index = 0) {
  const src = story.images[index];
  if (!src || !(src.startsWith('/api/news/') || /^https:\/\//.test(src))) return '';
  return `<img class="visual" src="${escape(src)}" alt="${escape(story.title)}${index ? ' · 카드 ' + (index + 1) : ''}" ${index ? 'loading="lazy"' : ''}>`;
}
function item(story) {
  return `<article><div class="label">현장 · ${date(story)}</div><h2><a href="${href(story)}">${escape(story.title)}</a></h2><p>${summary(story)}</p></article>`;
}
function render() {
  const screen = location.hash === '#screen';
  document.body.className = edition[0] + (screen ? ' display' : '');
  document.querySelector('#screen').textContent = screen ? '신문 홈' : '전시장 화면';
  const key = location.hash.startsWith('#article/') ? location.hash.slice(9) : '';
  const story = stories.find(s => encodeURIComponent(s.id) === key);
  const lead = stories[0];
  let content;
  if (!loaded) content = `<p role="status">${error || '기사를 불러오는 중입니다.'}</p>`;
  else if (key) content = story ? `<article class="detail"><a href="#">← 신문 홈</a><div class="label">현장 · ${date(story)}</div><h1>${escape(story.title)}</h1>${art(story)}<div class="article-copy">${story.caption.split(/\n+/).map(p => `<p>${escape(p)}</p>`).join('')}</div><div class="article-gallery">${story.images.slice(1).map((_, i) => art(story, i + 1)).join('')}</div></article>` : '<p>기사를 찾을 수 없습니다. <a href="#">신문 홈으로</a></p>';
  else if (!lead) content = '<p role="status">아직 게시된 기사가 없습니다. 검토 후 게시한 기사가 여기에 표시됩니다.</p>';
  else content = `<div class="ticker"><b>최신 기사</b><a href="${href(lead)}">${escape(lead.title)}</a></div><div class="bodygrid"><section class="lead"><div class="label">${escape(edition[3])} · ${date(lead)}</div><h1><a href="${href(lead)}">${escape(lead.title)}</a></h1><p class="deck">${summary(lead)}</p><a href="${href(lead)}">기사 전문 읽기 →</a>${art(lead)}</section>${stories.length > 1 ? `<aside class="aside"><div class="label">함께 읽기</div>${stories.slice(1, 3).map(item).join('')}</aside>` : ''}</div><div class="cards">${stories.slice(3).map(item).join('')}</div>`;
  app.innerHTML = `<header><div class="meta">${escape(edition[2])} / ${escape(edition[1])}</div><div class="mast"><a href="#">${mast}</a></div><nav class="nav" aria-label="신문 스타일">${Object.entries(editions).map(([path, name]) => `<a href="/${path}"${path === slug ? ' aria-current="page"' : ''}>${name}</a>`).join('')}</nav></header><main><p class="notice">AI가 생성한 전시 작품 속 기사 · 실제 언론사와 무관한 독립 전시입니다.${error && loaded ? ' · ' + error : ''}</p><aside class="hack-ad" aria-label="해커톤 광고"><div><div class="label">광고 · 해커톤 참가작</div><h2>2026 아트코리아랩 예술 해커톤</h2><p>휴먼 인 더 루프 · 3조 〈PAPARAZZI BOT〉</p><p>당신의 반응이 AI 기자의 다음 기사를 바꿉니다.</p></div><a href="https://docs.google.com/presentation/d/1MKCZO1rljj_4Z0fuTwrYCNkvjMpsxXj2/edit?slide=id.p1#slide=id.p1" target="_blank" rel="noopener noreferrer">해커톤 슬라이드 보기 ↗</a></aside>${content}</main><footer>PAPARAZZI BOT · TEAM 03 · AI 생성 전시 기사</footer>`;
  document.title = (story?.title || edition[2]) + ' · PAPARAZZI BOT';
}
async function refresh() {
  if (fetching) { refreshPending = true; return; }
  fetching = true;
  try {
    const response = await fetch('/api/news', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error();
    const data = await response.json();
    if (!Array.isArray(data.items)) throw Error();
    const changed = !loaded || error || JSON.stringify(stories) !== JSON.stringify(data.items);
    stories = data.items; loaded = true; error = '';
    if (changed) render();
  } catch {
    error = '최신 기사를 불러오지 못했습니다. 잠시 후 다시 연결합니다.';
    render();
  } finally {
    fetching = false;
    if (refreshPending) { refreshPending = false; void refresh(); }
  }
}
document.querySelector('#screen').onclick = () => {
  const screen = location.hash !== '#screen';
  location.hash = screen ? 'screen' : '';
  if (screen) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
};
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
window.addEventListener('online', refresh);
const style = document.createElement('style');
style.textContent = '.nav [aria-current=page]{font-weight:800;text-decoration:underline;text-underline-offset:5px}.article-copy{overflow-wrap:anywhere}.article-gallery{display:grid;gap:20px}.detail .visual{margin:20px 0}.lead h1,.aside h2,.cards h2{overflow-wrap:anywhere}';
document.head.append(style);
render();
refresh();
if (typeof EventSource !== 'undefined') {
  const updates = new EventSource('/api/news/events');
  updates.addEventListener('published', refresh);
  updates.addEventListener('ready', refresh);
}
setInterval(refresh, 10000);
