'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const yauzl = require('yauzl');
const { mergeIni } = require('./iniMerge');

const META = '.launcher';               // <install>/.launcher  (state, baselines, backups)
const KEEP_BACKUPS = 5;
const NEVER_IMPORT = /^(uninstall[^/]*|.*\.(exe|dll))$/i; // not carried over when migrating

const isIni = (rel) => /\.ini$/i.test(rel);
const norm = (rel) => rel.split(path.sep).join('/');

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

async function walk(dir, base = dir, out = []) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== META) await walk(full, base, out); }
    else if (e.isFile()) out.push(norm(path.relative(base, full)));
  }
  return out;
}

function sha1(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function sameFile(a, b) {
  const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
  if (sa.size !== sb.size) return false;
  return (await sha1(a)) === (await sha1(b));
}

// ---------- install discovery / state ----------

async function isGameDir(dir) {
  return !!dir && (await exists(path.join(dir, 'Endless.exe')));
}

async function isWritable(dir) {
  const probe = path.join(dir, `.eo-write-test-${process.pid}`);
  try { await fsp.writeFile(probe, ''); await fsp.unlink(probe); return true; } catch { return false; }
}

function defaultInstallDir() {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(root, 'Endless Online');
}

async function detectInstalls() {
  const c = [
    defaultInstallDir(),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Endless Online'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Endless Online'),
    path.join(os.homedir(), 'Desktop', 'Endless Online'),
    'C:\\Endless Online',
  ].filter(Boolean);
  const out = [];
  for (const dir of c) if (await isGameDir(dir)) out.push(dir);
  return out;
}

async function readState(installDir) {
  try { return JSON.parse(await fsp.readFile(path.join(installDir, META, 'state.json'), 'utf8')); }
  catch { return null; }
}

async function writeState(installDir, state) {
  await fsp.mkdir(path.join(installDir, META), { recursive: true });
  await fsp.writeFile(path.join(installDir, META, 'state.json'), JSON.stringify(state, null, 2));
}

// ---------- download ----------

async function downloadFile(fetchFn, url, dest, onProgress = () => {}, signal) {
  const res = await fetchFn(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let done = 0; const t0 = Date.now();
  try {
    for (;;) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      done += value.length;
      const secs = (Date.now() - t0) / 1000 || 1;
      onProgress({ phase: 'download', done, total, bytesPerSec: done / secs });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (total && done !== total) throw new Error('Download was cut off; please try again.');
  return dest;
}

// ---------- extract ----------

function extractZip(zipPath, destDir, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(new Error('The downloaded package is not a valid ZIP: ' + err.message));
      const total = zip.entryCount; let n = 0;
      const root = path.resolve(destDir);
      zip.on('error', reject);
      zip.on('end', () => resolve());
      zip.on('entry', (entry) => {
        n++;
        const target = path.resolve(root, entry.fileName);
        if (target !== root && !target.startsWith(root + path.sep)) return reject(new Error('Unsafe path in ZIP: ' + entry.fileName));
        if (/\/$/.test(entry.fileName)) {
          return fs.mkdir(target, { recursive: true }, (e) => (e ? reject(e) : zip.readEntry()));
        }
        fs.mkdir(path.dirname(target), { recursive: true }, (e) => {
          if (e) return reject(e);
          zip.openReadStream(entry, (e2, rs) => {
            if (e2) return reject(e2);
            const ws = fs.createWriteStream(target);
            rs.on('error', reject); ws.on('error', reject);
            ws.on('close', () => { onProgress({ phase: 'extract', done: n, total, file: entry.fileName }); zip.readEntry(); });
            rs.pipe(ws);
          });
        });
      });
      zip.readEntry();
    });
  });
}

/** The ZIP may or may not wrap everything in a folder: find the dir holding Endless.exe. */
async function findPackageRoot(dir, depth = 0) {
  if (await isGameDir(dir)) return dir;
  if (depth >= 3) return null;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { const r = await findPackageRoot(path.join(dir, e.name), depth + 1); if (r) return r; }
  }
  return null;
}

// ---------- apply ----------

async function backupFile(installDir, backupDir, rel) {
  const dst = path.join(backupDir, rel);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(path.join(installDir, rel), dst);
}

async function pruneBackups(installDir) {
  const dir = path.join(installDir, META, 'backups');
  if (!(await exists(dir))) return;
  const all = (await fsp.readdir(dir)).sort().reverse();
  for (const old of all.slice(KEEP_BACKUPS)) await fsp.rm(path.join(dir, old), { recursive: true, force: true });
}

/**
 * Copy a freshly extracted package over an install.
 *  - files only the user has (saved logins in data/scene, screenshots, chat logs,
 *    custom themes ...) are never touched, because nothing is ever deleted
 *  - *.ini files are merged key-by-key instead of overwritten
 *  - everything else is replaced when its content differs
 */
async function applyPackage({ packageRoot, installDir, version, onProgress = () => {} }) {
  await fsp.mkdir(installDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(installDir, META, 'backups', stamp);
  const baselineDir = path.join(installDir, META, 'baseline');
  const files = await walk(packageRoot);
  const report = { version, updated: 0, added: 0, unchanged: 0, merged: [], backupDir: null };

  // Pre-flight: fail early (before changing anything) if the game is running.
  for (const exe of files.filter((f) => /\.exe$/i.test(f))) {
    const p = path.join(installDir, exe);
    if (await exists(p)) {
      try { const fh = await fsp.open(p, 'r+'); await fh.close(); }
      catch (e) {
        if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw new Error(`${exe} is in use or not writable. Close Endless Online and try again.`);
        throw e;
      }
    }
  }

  let i = 0;
  for (const rel of files) {
    i++;
    const src = path.join(packageRoot, rel);
    const dst = path.join(installDir, rel);
    onProgress({ phase: 'apply', done: i, total: files.length, file: rel });

    if (!(await exists(dst))) {
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(src, dst);
      report.added++;
    } else if (isIni(rel)) {
      const newText = await fsp.readFile(src, 'latin1');
      const userText = await fsp.readFile(dst, 'latin1');
      const basePath = path.join(baselineDir, rel);
      const baseText = (await exists(basePath)) ? await fsp.readFile(basePath, 'latin1') : null;
      const m = mergeIni(newText, userText, baseText);
      if (m.text !== userText) {
        await backupFile(installDir, backupDir, rel); report.backupDir = backupDir;
        const tmp = dst + '.eo-new';
        await fsp.writeFile(tmp, m.text, 'latin1');
        await fsp.rename(tmp, dst);
        report.updated++;
      } else report.unchanged++;
      report.merged.push({ file: rel, kept: m.kept, adopted: m.adopted, added: m.added, dropped: m.dropped });
    } else if (await sameFile(src, dst)) {
      report.unchanged++;
    } else {
      await fsp.copyFile(src, dst);
      report.updated++;
    }

    // Remember what this version shipped, for the next 3-way merge.
    if (isIni(rel)) {
      const b = path.join(baselineDir, rel);
      await fsp.mkdir(path.dirname(b), { recursive: true });
      await fsp.copyFile(src, b);
    }
  }

  await writeState(installDir, { version, updatedAt: new Date().toISOString() });
  await pruneBackups(installDir);
  return report;
}

/**
 * Bring personal data from an old install (e.g. Program Files) into a new one:
 * configs are merged onto the new files; files the new install doesn't have
 * (saved logins, screenshots, logs, custom themes) are copied across.
 */
async function importUserData({ fromDir, installDir, onProgress = () => {} }) {
  const files = (await walk(fromDir)).filter((rel) => !NEVER_IMPORT.test(path.posix.basename(rel)));
  const report = { copied: [], merged: [] };
  let i = 0;
  for (const rel of files) {
    i++;
    onProgress({ phase: 'import', done: i, total: files.length, file: rel });
    const src = path.join(fromDir, rel);
    const dst = path.join(installDir, rel);
    if (!(await exists(dst))) {
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(src, dst);
      report.copied.push(rel);
    } else if (isIni(rel)) {
      const newText = await fsp.readFile(dst, 'latin1');
      const m = mergeIni(newText, await fsp.readFile(src, 'latin1'), null);
      if (m.text !== newText) await fsp.writeFile(dst, m.text, 'latin1');
      report.merged.push({ file: rel, kept: m.kept, adopted: [], added: m.added, dropped: m.dropped });
    }
  }
  return report;
}

/** Full flow: download -> extract -> apply (-> import) -> clean up. */
async function runUpdate({ fetchFn, release, installDir, importFrom = null, tempRoot = os.tmpdir(), onProgress = () => {}, signal }) {
  const work = await fsp.mkdtemp(path.join(tempRoot, 'eo-update-'));
  try {
    const zip = path.join(work, 'client.zip');
    await downloadFile(fetchFn, release.zipUrl, zip, onProgress, signal);
    const staging = path.join(work, 'staging');
    await extractZip(zip, staging, onProgress);
    const packageRoot = await findPackageRoot(staging);
    if (!packageRoot) throw new Error('The package does not look like an Endless Online client (Endless.exe not found).');
    const report = await applyPackage({ packageRoot, installDir, version: release.version, onProgress });
    if (importFrom && path.resolve(importFrom) !== path.resolve(installDir)) {
      report.imported = await importUserData({ fromDir: importFrom, installDir, onProgress });
    }
    return report;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  runUpdate, applyPackage, importUserData, extractZip, downloadFile, findPackageRoot,
  detectInstalls, defaultInstallDir, isGameDir, isWritable, readState, writeState,
};
