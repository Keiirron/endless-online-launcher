'use strict';
const $ = (id) => document.getElementById(id);
const SITE = 'https://www.endless-online.com/';
let st = null; let rel = null; let running = false;

const mb = (n) => (n ? (n / 1048576).toFixed(1) + ' MB' : '');
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

// ---------- state -> UI ----------
function render() {
  $('vInstalled').textContent = !st ? '–' : !st.installed ? 'Not installed' : st.version || 'Unknown version';
  $('vLatest').textContent = rel ? rel.version : '–';
  $('dirLine').textContent = st ? st.installDir : '';
  $('btnOpen').hidden = $('btnCfg').hidden = !(st && st.installed);
  if (running) return;

  const btn = $('btnMain'); btn.className = 'primary'; btn.disabled = false;
  const notice = $('notice'); notice.hidden = true; notice.className = 'notice';

  if (!st) { btn.disabled = true; btn.textContent = 'Checking…'; return; }
  if (!rel) {                       // offline / site unreachable: still let people play
    btn.textContent = st.installed ? 'Play' : 'Retry'; btn.dataset.action = st.installed ? 'play' : 'retry';
    if (st.installed) btn.classList.add('play');
    return;
  }
  if (st.installed && !st.writable) {
    notice.hidden = false;
    notice.replaceChildren(
      el('div', {}, 'This install is in a protected folder (such as Program Files), so it cannot be updated without administrator rights.'),
      el('div', { className: 'muted' }, `The launcher can set up a fresh copy in ${st.suggestedDir} and bring your saved logins, settings and screenshots across. Your old folder is left untouched.`),
      el('button', { className: 'secondary', onclick: () => doUpdate({ migrate: true }) }, 'Move my game and update'));
    btn.textContent = 'Play'; btn.dataset.action = 'play'; btn.classList.add('play');
    setStatus(`Version ${rel.version} is available.`);
    return;
  }
  if (!st.installed) { btn.textContent = `Install ${rel.version}`; btn.dataset.action = 'update'; setStatus('Ready to install.'); }
  else if (st.version !== rel.version) {
    btn.textContent = `Update to ${rel.version}`; btn.dataset.action = 'update';
    setStatus(st.version ? `Update available: ${st.version} → ${rel.version}` : 'This copy was not installed by the launcher. Update once to bring it up to date; your logins and settings are kept.');
  } else { btn.textContent = 'Play'; btn.dataset.action = 'play'; btn.classList.add('play'); setStatus('You are up to date.'); setBar(1); }
}

function setStatus(t) { $('statusText').textContent = t; }
function setBar(f) { $('barFill').style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%'; }

function renderDownloads() {
  const ul = $('downloads'); ul.replaceChildren();
  if (!rel) { ul.append(el('li', { className: 'muted' }, 'Could not reach endless-online.com')); return; }
  const item = (name, note, size, url, tag) => el('li', {},
    el('div', {}, name, tag ? el('span', { className: 'tag' }, tag) : '', el('small', {}, [note, mb(size)].filter(Boolean).join(' · '))),
    el('button', { className: 'link', onclick: () => window.eo.open(url) }, 'Download'));
  ul.append(item(`Client ${rel.version} (ZIP)`, 'Used by this launcher', rel.zipSize, rel.zipUrl, 'auto'));
  if (rel.setupUrl) ul.append(item(`Installer ${rel.version} (EXE)`, 'Official setup program', rel.setupSize, rel.setupUrl));
}

// ---------- progress ----------
const PHASES = { download: [0, 0.6], extract: [0.6, 0.75], apply: [0.75, 0.97], import: [0.97, 1] };
window.eo.onProgress((p) => {
  const [a, b] = PHASES[p.phase] || [0, 1];
  const f = p.total ? p.done / p.total : 0;
  setBar(a + (b - a) * f);
  if (p.phase === 'download') {
    const eta = p.bytesPerSec && p.total ? Math.ceil((p.total - p.done) / p.bytesPerSec) : null;
    setStatus(`Downloading… ${mb(p.done)}${p.total ? ' of ' + mb(p.total) : ''} · ${mb(p.bytesPerSec)}/s${eta != null ? ` · ${eta}s left` : ''}`);
  } else {
    const label = { extract: 'Unpacking', apply: 'Updating files', import: 'Bringing your data across' }[p.phase];
    setStatus(`${label}… ${p.done}/${p.total}  ${p.file || ''}`);
  }
});

// ---------- actions ----------
async function doUpdate(opts) {
  if (running) return;
  running = true; $('btnMain').disabled = true; $('btnMain').textContent = 'Working…'; $('notice').hidden = true; setBar(0);
  try {
    const r = await window.eo.update(opts);
    st = r.status; showReport(r.report);
  } catch (e) {
    showError(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  } finally { running = false; render(); }
}

function showError(msg) {
  const n = $('notice'); n.hidden = false; n.className = 'notice bad'; n.replaceChildren(el('div', {}, msg));
  // render() hides the notice, so re-show after it runs
  setTimeout(() => { n.hidden = false; n.className = 'notice bad'; setStatus('Update failed. Nothing was lost; you can try again.'); setBar(0); });
}

function showReport(rep) {
  const body = $('reportBody'); body.replaceChildren();
  body.append(el('div', {}, el('b', {}, `${rep.updated} updated, ${rep.added} new, ${rep.unchanged} unchanged`)));
  const kv = (x) => `[${x.section}] ${x.key}`;
  const merged = [...rep.merged, ...((rep.imported && rep.imported.merged) || [])];
  for (const m of merged) {
    const lines = [
      ...m.kept.map((x) => `kept your ${kv(x)} = ${x.value}`),
      ...m.adopted.map((x) => `new default ${kv(x)} = ${x.to}`),
      ...m.added.map((x) => `new setting ${kv(x)} = ${x.value}`),
      ...m.dropped.map((x) => `removed obsolete ${kv(x)}`),
    ];
    if (!lines.length) continue;
    body.append(el('div', {}, el('b', {}, m.file)), el('ul', {}, ...lines.map((l) => el('li', {}, l))));
  }
  if (rep.imported) body.append(el('div', {}, `${rep.imported.copied.length} personal files brought across (saved logins, screenshots, etc.)`));
  if (rep.backupDir) body.append(el('div', {}, 'Backup of your previous configs: ', rep.backupDir));
  $('report').hidden = false;
}

$('btnMain').onclick = async () => {
  const a = $('btnMain').dataset.action;
  if (a === 'update') doUpdate({});
  else if (a === 'retry') init();
  else if (a === 'play') { try { await window.eo.play(); setStatus('Game started. Have fun!'); } catch (e) { showError(String(e.message || e)); } }
};
$('btnDir').onclick = async () => { if (!running) { st = await window.eo.chooseDir(); render(); } };
$('btnOpen').onclick = () => window.eo.openFolder();
$('btnCfg').onclick = () => window.eo.config();

// ---------- dev posts (sanitised: whitelist of tags, no attributes except safe href/src) ----------
const ALLOWED = new Set(['TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH', 'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'A', 'IMG', 'DIV', 'SPAN', 'FONT', 'CENTER', 'HR', 'PRE', 'CODE']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'LINK', 'META', 'NOSCRIPT', 'SVG', 'HEAD', 'TITLE']);

function clean(node, baseUrl, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) { out.append(child.textContent); continue; }
    if (child.nodeType !== Node.ELEMENT_NODE || DROP.has(child.tagName)) continue;
    if (!ALLOWED.has(child.tagName)) { clean(child, baseUrl, out); continue; }
    const tag = ['FONT', 'CENTER'].includes(child.tagName) ? 'span' : child.tagName.toLowerCase();
    const e = document.createElement(tag);
    try {
      if (tag === 'a' && child.getAttribute('href')) { const u = new URL(child.getAttribute('href'), baseUrl); if (/^https?:$/.test(u.protocol)) e.href = u.href; }
      if (tag === 'img') { const u = new URL(child.getAttribute('src') || '', baseUrl); if (!/(^|\.)endless-online\.com$/.test(u.hostname)) continue; u.protocol = 'https:'; e.src = u.href; e.alt = child.getAttribute('alt') || ''; }
      if ((tag === 'td' || tag === 'th') && child.getAttribute('colspan')) e.colSpan = Number(child.getAttribute('colspan')) || 1;
    } catch { continue; }
    clean(child, baseUrl, e);
    out.append(e);
  }
}

/* The site's dev post pages are old-school nested layout tables: a nav row, the banner, the post, a footer.
   We lift out just the post: grey "About: Title" bar tables become section headings, the tables between them become the text. */
function extractPost(doc, baseUrl) {
  doc.querySelectorAll('script,style,.headercontainer').forEach((n) => n.remove());
  doc.querySelectorAll('a.headerlink, a.copyrightlink, img[src*="pleasevote"], img[src*="vote"]').forEach((n) => { const tr = n.closest('body > table > tbody > tr, body > table > tr'); if (tr) tr.remove(); });
  const out = document.createDocumentFragment();
  const leaf = [...doc.querySelectorAll('table')].filter((t) => !t.querySelector('table'));
  let subtitle = ''; let blocks = 0;
  const loose = [...doc.querySelectorAll('font')].filter((f) => !leaf.some((t) => t.contains(f)));
  const head = loose.findIndex((f) => /dev post/i.test(f.textContent) && f.textContent.length < 80);
  if (head >= 0 && loose[head + 1] && loose[head + 1].textContent.trim().length < 80) subtitle = loose[head + 1].textContent.trim();

  const hero = [...doc.querySelectorAll('img')].find((i) => !leaf.some((t) => t.contains(i)));
  if (hero) { const f = document.createDocumentFragment(); clean(hero.parentNode, baseUrl, f); const img = f.querySelector('img'); if (img) out.append(el('div', { className: 'hero' }, img)); }

  leaf.forEach((t, i) => {
    const text = t.textContent.replace(/\s+/g, ' ').trim();
    if (t.hasAttribute('bgcolor') && text.length < 120) {
      const b = t.querySelector('b'); const tag = b ? b.textContent.replace(':', '').trim() : '';
      const title = (b ? text.slice(text.indexOf(b.textContent) + b.textContent.length) : text).trim();
      const isNew = /\bNEW$/.test(title);
      out.append(el('h3', {}, tag ? el('span', { className: 'chip' }, tag) : '', title.replace(/\s*NEW$/, ''), isNew ? el('span', { className: 'chip new' }, 'New') : ''));
      blocks++; return;
    }
    if (!text && !t.querySelector('img')) return;
    const block = el('div', { className: 'block' }); clean(t, baseUrl, block);
    block.querySelectorAll('td').forEach((td) => { if (!td.textContent.trim() && !td.querySelector('img')) td.remove(); });
    out.append(block); blocks++;
  });
  return blocks >= 2 ? { body: out, subtitle } : null;
}

async function showPost(post) {
  $('postTitle').textContent = `Dev Post ${post.version}`;
  $('postMeta').textContent = post.date || '';
  const body = $('postBody'); body.replaceChildren(el('p', { className: 'muted' }, 'Loading…'));
  try {
    const html = await window.eo.devpost(post.url);
    let got = extractPost(new DOMParser().parseFromString(html, 'text/html'), post.url);
    if (!got) { const d = new DOMParser().parseFromString(html, 'text/html'); const f = document.createDocumentFragment(); clean(d.body, post.url, f); got = { body: f, subtitle: '' }; }
    if (got.subtitle) $('postTitle').textContent = got.subtitle;
    $('postMeta').textContent = [`Dev Post ${post.version}`, post.date].filter(Boolean).join(' · ');
    body.replaceChildren(got.body, el('p', { className: 'more' }, el('a', { href: post.url }, 'Read on endless-online.com')));
    body.scrollTop = 0;
  } catch { body.replaceChildren(el('p', { className: 'muted' }, 'Could not load this post. '), el('a', { href: post.url }, 'Open it in your browser')); }
}

async function loadPosts() {
  try {
    const posts = await window.eo.devposts();
    if (!posts.length) throw new Error('none');
    const pick = $('postPicker'); pick.replaceChildren(...posts.map((p, i) => el('option', { value: i }, `${p.version}${p.date ? ' · ' + p.date : ''}`)));
    pick.onchange = () => showPost(posts[pick.value]);
    showPost(posts[0]);
  } catch {
    $('postTitle').textContent = 'Dev posts unavailable';
    $('postBody').replaceChildren(el('p', { className: 'muted' }, 'Could not reach the dev posts right now. '), el('a', { href: SITE + 'devposts.html' }, 'Open them in your browser'));
  }
}

async function init() {
  setStatus('Checking for updates…');
  st = await window.eo.status();
  try { rel = await window.eo.release(); } catch { rel = null; setStatus('Could not check for updates (offline?). You can still play.'); }
  renderDownloads(); render();
}
init(); loadPosts();
