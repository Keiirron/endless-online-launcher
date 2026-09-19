'use strict';
/** Reads release + dev post info from the public endless-online.com pages. */

const SITE = 'https://www.endless-online.com';
const DOWNLOAD_PAGE = SITE + '/client/download.html';
const DEVPOSTS_PAGE = SITE + '/devposts.html';

async function getText(fetchFn, url) {
  const res = await fetchFn(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** "0456" -> "0.4.56" */
function prettyVersion(code) {
  return code.length === 4 ? `${+code[0]}.${+code[1]}.${code.slice(2)}` : code;
}

/** Find all client packages linked from a page; newest first. */
function parseDownloads(html, pageUrl) {
  const found = new Map();
  const re = /href\s*=\s*["']([^"']*?(EndlessOnline|EndlessSetup)(\d{3,6})\.(zip|exe))["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = new URL(m[1], pageUrl).href.replace(/^http:/, 'https:');
    const code = m[3];
    const entry = found.get(code) || { code, version: prettyVersion(code) };
    if (m[4].toLowerCase() === 'zip') entry.zipUrl = url; else entry.setupUrl = url;
    found.set(code, entry);
  }
  return [...found.values()].sort((a, b) => Number(b.code) - Number(a.code));
}

async function headSize(fetchFn, url) {
  try {
    const r = await fetchFn(url, { method: 'HEAD' });
    const n = Number(r.headers.get('content-length'));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** Latest release with download options. Only ever returns URLs on the official host. */
async function getLatestRelease(fetchFn) {
  const html = await getText(fetchFn, DOWNLOAD_PAGE);
  const list = parseDownloads(html, DOWNLOAD_PAGE).filter((r) => r.zipUrl);
  if (!list.length) throw new Error('No client download found on the official download page.');
  const latest = list[0];
  for (const u of [latest.zipUrl, latest.setupUrl]) {
    if (u && new URL(u).hostname.replace(/^www\./, '') !== 'endless-online.com') {
      throw new Error('Download link points off the official site; refusing: ' + u);
    }
  }
  latest.zipSize = await headSize(fetchFn, latest.zipUrl);
  latest.setupSize = latest.setupUrl ? await headSize(fetchFn, latest.setupUrl) : null;
  latest.notesUrl = DOWNLOAD_PAGE;
  return latest;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/** Dev post index, newest first: [{code, version, title, date, url}] */
function parseDevPosts(html) {
  const posts = [];
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(html))) {
    const link = /href\s*=\s*["']([^"']*devpost\/(\d+)\.html?)["'][^>]*>([\s\S]*?)<\/a>/i.exec(row[0]);
    if (!link) continue;
    const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripTags(c[1]));
    const date = cells.find((c) => /\b\d{1,2}\s+\w+\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(c)) || '';
    posts.push({
      code: link[2],
      version: prettyVersion(link[2]),
      title: stripTags(link[3]).replace(/\bNEW\b/i, '').trim(),
      date,
      url: new URL(link[1], DEVPOSTS_PAGE).href.replace(/^http:/, 'https:'),
    });
  }
  return posts.sort((a, b) => Number(b.code) - Number(a.code));
}

async function getDevPosts(fetchFn) {
  return parseDevPosts(await getText(fetchFn, DEVPOSTS_PAGE));
}

/** Raw HTML of one post. The renderer sanitises it before display. */
async function getDevPostHtml(fetchFn, url) {
  const u = new URL(url);
  if (u.hostname.replace(/^www\./, '') !== 'endless-online.com') throw new Error('Not an official dev post URL');
  return getText(fetchFn, u.href);
}

module.exports = { getLatestRelease, getDevPosts, getDevPostHtml, parseDownloads, parseDevPosts, prettyVersion, SITE };
