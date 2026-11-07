const edition = JSON.parse(document.querySelector('#edition').textContent);
const app = document.querySelector('#app');
const editions = { elle: 'ELLE', vogue: 'VOGUE', chosun: '조선', donga: '동아', kyunghyang: '경향', time: 'TIME', newyorker: 'NEW YORKER', atlantic: 'ATLANTIC', natgeo: 'NAT GEO', wired: 'WIRED' };
const slug = location.pathname.startsWith('/editions/') ? location.pathname.split('/').pop().replace('.html', '') : location.pathname.split('/')[1];
const mast = ['time', 'newyorker', 'atlantic', 'natgeo', 'wired'].includes(slug) ? '해커톤일보' : 'PAPARAZZI BOT';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let stories = [], loaded = false, error = '', fetching = false, refreshPending = false;
const ads = [
  { imageId: '1BTgEHJzxzQFBHNyba-BPRZ2ru7gJ7G0K', href: 'https://sites.google.com/view/artist-sira', name: '강시라' },
  { imageId: '1Y0Rc3FgPXkNLp8E52h3dyabjEW-xhB_e', href: 'https://www.instagram.com/return_of_unny?dlrf=OGNnZThuZDJybXN5', name: '정윤언' },
  { imageId: '1A9w0McPd4s8vbdzDtzo_QUrtlnKlGpaL', href: 'https://docs.google.com/forms/d/e/1FAIpQLSesf50D9cIb_aI6nGy7vJnR-mEt2UxKhSFfGhMELKJJqYurSQ/viewform', name: '이형우' },
  { imageId: '1xkA78MUCpONn8lcob11tIt-YjRNDOcHa', href: 'https://youtube.com/shorts/KZpt_9P7p9c?si=NXOdFInzQjRa3wJe', name: '아트팜엘케이' },
];
let adIndex = Math.floor(Math.random() * ads.length);
const href = story => '#article/' + encodeURIComponent(story.id);
const date = story => escape(new Date(story.publishedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));
const summary = story => escape(story.caption.replaceAll('\n', ' ').slice(0, 140));
const newestFirst = (a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')) || String(a.id).localeCompare(String(b.id));
function art(story, index = 0) {
  const src = story.images[index];
  if (!src || !(src.startsWith('/api/news/') || /^https:\/\//.test(src))) return '';
  return `<img class="visual" src="${escape(src)}" alt="${escape(story.title)}${index ? ' · 카드 ' + (index + 1) : ''}" ${index ? 'loading="lazy"' : ''}>`;
}
function item(story) {
  return `<article><div class="label">현장 · ${date(story)}</div><h2><a href="${href(story)}">${escape(story.title)}</a></h2><p>${summary(story)}</p></article>`;
}
function ad() {
  const slide = (current, clone = false) => {
    const image = `https://drive.google.com/thumbnail?id=${encodeURIComponent(current.imageId)}&sz=w1600`;
    return `<div class="sponsor-slide"${clone ? ' aria-hidden="true"' : ''}><div class="label">ADVERTISEMENT · ${escape(current.name)}</div><a href="${escape(current.href)}" target="_blank" rel="noopener noreferrer sponsored" aria-label="${escape(current.name)} 광고 페이지로 이동 (새 창)"${clone ? ' tabindex="-1"' : ''}><img src="${image}" alt="${escape(current.name)} 광고" referrerpolicy="no-referrer"></a></div>`;
  };
  return `<aside class="sponsor-ad" aria-label="광고 캐러셀"><div class="sponsor-track" style="transform:translateX(-${adIndex * 100}%)">${ads.map(item => slide(item)).join('')}${slide(ads[0], true)}</div></aside>`;
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
  app.innerHTML = `<header><div class="meta">${escape(edition[2])} / ${escape(edition[1])}</div><div class="mast"><a href="#">${mast}</a></div><nav class="nav" aria-label="신문 스타일">${Object.entries(editions).map(([path, name]) => `<a href="/${path}"${path === slug ? ' aria-current="page"' : ''}>${name}</a>`).join('')}</nav></header><main><p class="notice">AI가 생성한 전시 작품 속 기사 · 실제 언론사와 무관한 독립 전시입니다.${error && loaded ? ' · ' + error : ''}</p>${ad()}${content}</main><footer>PAPARAZZI BOT · TEAM 03 · AI 생성 전시 기사</footer>`;
  document.title = (story?.title || edition[2]) + ' · PAPARAZZI BOT';
}
async function refresh() {
  if (fetching) { refreshPending = true; return; }
  fetching = true;
  try {
    const response = await fetch('/api/news', { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error();
    const data = await response.json();
    if (!Array.isArray(data.items)) throw Error();
    const changed = !loaded || error || JSON.stringify(stories) !== JSON.stringify(data.items);
    stories = [...data.items].sort(newestFirst); loaded = true; error = '';
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
setInterval(() => {
  if (ads.length < 2 || document.hidden) return;
  const track = document.querySelector('.sponsor-track');
  if (!track) return;
  adIndex += 1;
  track.classList.add('is-moving');
  track.style.transform = `translateX(-${adIndex * 100}%)`;
  if (adIndex === ads.length) {
    const reset = () => {
      if (adIndex !== ads.length) return;
      track.classList.remove('is-moving');
      adIndex = 0;
      track.style.transform = 'translateX(0)';
    };
    track.addEventListener('transitionend', reset, { once: true });
    setTimeout(reset, 300);
  }
}, 3000);
