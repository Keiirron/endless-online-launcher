'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const { mergeIni } = require('../src/iniMerge');
const { runUpdate, readState } = require('../src/updater');
const { parseDownloads, parseDevPosts } = require('../src/site');

const ini = (lines) => lines.join('\r\n');

const SHIPPED_OLD = ini(['# Endless Online 0.4  [ configuration file ]', '', '[CONNECTION]', "# tip: enter 'Host=' then a name", 'Host=game.endless-online.com', 'Port=8078', '', '[SOUND]', 'Music=50', 'Sound=on', '', '[OLD]', 'Legacy=1', '']);
const USER = ini(['# Endless Online 0.4  [ configuration file ]', '', '[CONNECTION]', "# tip: enter 'Host=' then a name", 'Host=game.endless-online.com', 'Port=8078', '', '[SOUND]', 'Music=30', 'Sound=on', '', '[OLD]', 'Legacy=1', '']);
const SHIPPED_NEW = ini(['# Endless Online 0.5  [ configuration file ]', '', '[CONNECTION]', "# tip: enter 'Host=' then a name", 'Host=play.endless-online.com', 'Port=8078', '', '[SOUND]', 'Music=50', 'Sound=on', 'Ambience=on', '', '[WEATHER]', 'Rain=on', '']);

test('3-way merge: keeps user edits, adopts new defaults, adds new keys, keeps new comments', () => {
  const m = mergeIni(SHIPPED_NEW, USER, SHIPPED_OLD);
  assert.match(m.text, /Music=30/);                         // user changed it -> kept
  assert.match(m.text, /Host=play\.endless-online\.com/);   // user never touched -> new default
  assert.match(m.text, /Ambience=on/);                      // new key survives
  assert.match(m.text, /\[WEATHER\]\r\nRain=on/);           // new section survives
  assert.match(m.text, /configuration file/);
  assert.match(m.text, /0\.5/);                             // new header comment
  assert.doesNotMatch(m.text, /Legacy/);                    // obsolete key dropped
  assert.deepStrictEqual(m.dropped.map((d) => d.key), ['Legacy']);
  assert.ok(m.text.includes("# tip: enter 'Host=' then a name")); // comment with '=' untouched
  assert.ok(!/[^\r]\n/.test(m.text), 'CRLF preserved');
});

test('2-way merge (no baseline): user value always wins for shared keys', () => {
  const m = mergeIni(SHIPPED_NEW, USER, null);
  assert.match(m.text, /Host=game\.endless-online\.com/);
  assert.match(m.text, /Music=30/);
  assert.match(m.text, /Ambience=on/);
});

function makeZip(file, entries, prefix = '') {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) z.addBuffer(Buffer.from(content, 'latin1'), prefix + name);
    z.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve);
    z.end();
  });
}
const fakeFetch = (zip) => async () => new Response(fs.readFileSync(zip), { headers: { 'content-length': String(fs.statSync(zip).size) } });

test('full update: logins + screenshots survive, config merged, new files land, backup made', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-test-'));
  const install = path.join(tmp, 'install');
  const put = (rel, c) => { const p = path.join(install, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, 'latin1'); };
  const get = (rel) => fs.readFileSync(path.join(install, rel), 'latin1');

  // v1 via the launcher (creates the baseline)
  const zip1 = path.join(tmp, 'v1.zip');
  await makeZip(zip1, { 'Endless.exe': 'EXE-v1', 'config/setup.ini': SHIPPED_OLD, 'data/scene/sce001.ess': 'scene1' }, 'EndlessOnline/');
  await runUpdate({ fetchFn: fakeFetch(zip1), release: { zipUrl: 'x', version: '0.4.55' }, installDir: install, tempRoot: tmp });

  // the user plays: changes a setting, saves a login, takes a screenshot
  put('config/setup.ini', USER);
  put('data/scene/name', 'SAVED-LOGIN-BLOB\x00\x01\xff');
  put('screen/shot1.bmp', 'BMP');

  // v2 ships a changed config, a new config file and a new exe
  const zip2 = path.join(tmp, 'v2.zip');
  await makeZip(zip2, { 'Endless.exe': 'EXE-v2', 'config/setup.ini': SHIPPED_NEW, 'config/keys.ini': '[KEYS]\r\nJump=space\r\n', 'data/scene/sce001.ess': 'scene1' });
  const phases = new Set();
  const report = await runUpdate({ fetchFn: fakeFetch(zip2), release: { zipUrl: 'x', version: '0.4.56' }, installDir: install, tempRoot: tmp, onProgress: (p) => phases.add(p.phase) });

  assert.strictEqual(get('Endless.exe'), 'EXE-v2');
  assert.strictEqual(get('data/scene/name'), 'SAVED-LOGIN-BLOB\x00\x01\xff');
  assert.strictEqual(get('screen/shot1.bmp'), 'BMP');
  assert.match(get('config/setup.ini'), /Music=30/);
  assert.match(get('config/setup.ini'), /Host=play\./);
  assert.match(get('config/setup.ini'), /Ambience=on/);
  assert.match(get('config/keys.ini'), /Jump=space/);
  assert.strictEqual((await readState(install)).version, '0.4.56');
  assert.ok(report.backupDir && fs.readFileSync(path.join(report.backupDir, 'config/setup.ini'), 'latin1') === USER);
  assert.deepStrictEqual([...phases].sort(), ['apply', 'download', 'extract']);
  assert.strictEqual(report.unchanged, 1);

  // migration: brand-new location importing from the old one
  const fresh = path.join(tmp, 'fresh');
  const r2 = await runUpdate({ fetchFn: fakeFetch(zip2), release: { zipUrl: 'x', version: '0.4.56' }, installDir: fresh, importFrom: install, tempRoot: tmp });
  assert.strictEqual(fs.readFileSync(path.join(fresh, 'data/scene/name'), 'latin1'), 'SAVED-LOGIN-BLOB\x00\x01\xff');
  assert.match(fs.readFileSync(path.join(fresh, 'config/setup.ini'), 'latin1'), /Music=30/);
  assert.ok(r2.imported.copied.includes('screen/shot1.bmp'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('zip-slip is rejected', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-test-'));
  const zip = path.join(tmp, 'evil.zip');
  await makeZip(zip, { 'Endless.exe': 'x' });
  // patch the stored name to a traversal path of equal length
  const buf = fs.readFileSync(zip); const evil = Buffer.from('../../x.exe');
  let at = -1; while ((at = buf.indexOf('Endless.exe', at + 1)) !== -1) evil.copy(buf, at);
  fs.writeFileSync(zip, buf);
  await assert.rejects(runUpdate({ fetchFn: fakeFetch(zip), release: { zipUrl: 'x', version: 'z' }, installDir: path.join(tmp, 'i'), tempRoot: tmp }));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('site parsing', () => {
  const d = parseDownloads('<a href="0_04/EndlessSetup0456.exe">x</a><a href="https://www.endless-online.com/client/0_04/EndlessOnline0456.zip">z</a><a href="0_04/EndlessOnline0453.zip">old</a>', 'https://www.endless-online.com/client/download.html');
  assert.strictEqual(d[0].version, '0.4.56');
  assert.strictEqual(d[0].zipUrl, 'https://www.endless-online.com/client/0_04/EndlessOnline0456.zip');
  assert.strictEqual(d[0].setupUrl, 'https://www.endless-online.com/client/0_04/EndlessSetup0456.exe');
  const p = parseDevPosts('<table><tr><td><a href="devpost/0452.html">Dev Post - Release | 0.4.52</a></td><td>Vult-r</td><td>1 August 2026</td></tr><tr><td><a href="http://www.endless-online.com/devpost/0453.html">Dev Post - Release | 0.4.53</a> NEW</td><td>Vult-r</td><td>0.4.53</td><td>7 August 2026</td></tr></table>');
  assert.strictEqual(p[0].code, '0453');
  assert.strictEqual(p[0].date, '7 August 2026');
  assert.strictEqual(p[0].url, 'https://www.endless-online.com/devpost/0453.html');
});
