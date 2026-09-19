'use strict';
/**
 * Key-level INI merge for Endless Online config files.
 *
 * The NEW file shipped with the update is always the template: its sections,
 * comments, ordering and any brand-new keys are kept exactly. For each key
 * that also exists in the user's file we decide whose value wins:
 *
 *   3-way (baseline = the file as shipped by the PREVIOUS version):
 *     user == baseline  -> user never touched it  -> take NEW default
 *     user != baseline  -> user customised it      -> keep USER value
 *   2-way (no baseline, e.g. first run on an existing install):
 *     keep USER value.
 *
 * Keys the user has that the new file no longer contains are dropped (and
 * reported) so obsolete settings can't break a newer client. The user's
 * original file is always backed up by the updater before this runs.
 *
 * Files are handled as latin1 strings so bytes round-trip unchanged.
 */

const LINE_RE = /^(\s*)([^=#;\[\]\r\n][^=\r\n]*?)(\s*=\s*)(.*?)(\s*)$/;
const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;

function isComment(line) {
  const t = line.trimStart();
  return t.startsWith('#') || t.startsWith(';');
}

/** Parse to Map<"section\u0000key" (lowercased), {section,key,value}> */
function parse(text) {
  const map = new Map();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    if (isComment(line)) continue;
    const s = SECTION_RE.exec(line);
    if (s) { section = s[1].trim(); continue; }
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const key = m[2].trim();
    map.set(id(section, key), { section, key, value: m[4] });
  }
  return map;
}

function id(section, key) {
  return section.toLowerCase() + '\u0000' + key.toLowerCase();
}

/**
 * @param {string} newText   file shipped in the update
 * @param {string} userText  file currently on disk
 * @param {string|null} baseText file shipped by the previously installed version (optional)
 * @returns {{text:string, kept:Array, adopted:Array, added:Array, dropped:Array}}
 */
function mergeIni(newText, userText, baseText = null) {
  const user = parse(userText);
  const base = baseText != null ? parse(baseText) : null;
  const eol = newText.includes('\r\n') ? '\r\n' : '\n';
  const report = { kept: [], adopted: [], added: [], dropped: [] };
  const seen = new Set();

  let section = '';
  const out = newText.split(/\r?\n/).map((line) => {
    if (isComment(line)) return line;
    const s = SECTION_RE.exec(line);
    if (s) { section = s[1].trim(); return line; }
    const m = LINE_RE.exec(line);
    if (!m) return line;

    const key = m[2].trim();
    const k = id(section, key);
    seen.add(k);
    const newVal = m[4];
    const u = user.get(k);

    if (!u) { report.added.push({ section, key, value: newVal }); return line; }
    if (u.value === newVal) return line;

    const b = base && base.get(k);
    const userCustomised = b ? u.value !== b.value : true;
    if (userCustomised) {
      report.kept.push({ section, key, value: u.value, shipped: newVal });
      return m[1] + m[2] + m[3] + u.value + m[5];
    }
    report.adopted.push({ section, key, from: u.value, to: newVal });
    return line;
  });

  for (const [k, u] of user) {
    if (!seen.has(k)) report.dropped.push({ section: u.section, key: u.key, value: u.value });
  }
  return { text: out.join(eol), ...report };
}

module.exports = { mergeIni, parse };
