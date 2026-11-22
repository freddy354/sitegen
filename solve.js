// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Reimplements makefun-site's build with byte-identical output, optimised for
// CPU time. Nothing is cached from one case to the next: every cache below is
// created fresh inside build() for one input. Node 22, stdlib only, no deps.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const INCLUDE_DEPTH = 8;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `text` with & < > " and ' escaped. A single replace pass: with no match it returns the text unchanged, so a separate pre-scan would only add a second scan. */
export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Whether UTF-16 code unit `c` is whitespace in JavaScript's \s sense. */
function isWS(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** The slug of `text`, exactly as makefun-site's slugify, with a per-case cache and an ASCII fast path. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (ascii) {
    // NFKD is the identity on ASCII and there are no combining marks to drop.
    // Accumulate the kept characters and join once, instead of += per character.
    const parts = [];
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = null;
      if (c >= 65 && c <= 90) keep = String.fromCharCode(c + 32);
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = text[i];
      if (keep === null) { gap = parts.length > 0; continue; }
      if (gap) parts.push('-');
      gap = false;
      parts.push(keep);
    }
    out = parts.join('').slice(0, 64).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    const parts = [];
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = parts.length > 0; continue; }
      if (gap) parts.push('-');
      gap = false;
      parts.push(keep);
    }
    out = parts.join('').slice(0, 64).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  }
  cache.set(text, out);
  return out;
}

/**
 * `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken.
 * `next` remembers the suffix to try next for each base, so a repeated collision does not rescan from 2.
 * Suffixes are only ever added, never removed, so the first free suffix at or after `next` is the answer.
 */
function uniqueSlug(slug, taken, next) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = next.get(slug) || 2;
  let out;
  for (;;) {
    out = `${slug}-${n}`;
    if (!taken.has(out)) break;
    n++;
  }
  next.set(slug, n + 1);
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone, with a per-case cache. */
function longDate(date, cache) {
  let v = cache.get(date);
  if (v === undefined) {
    const [y, m, d] = date.split('-');
    v = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    cache.set(date, v);
  }
  return v;
}

/** The words of a body: its runs of characters other than whitespace, counted by a scan (no regex, no array). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWS(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { n++; inWord = true; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error } with the first reason it is refused. */
export function parseFrontMatter(text) {
  // lines[0] must be exactly '---': the text is '---' alone, or opens '---\n'.
  if (text.length < 3 || text[0] !== '-' || text[1] !== '-' || text[2] !== '-' || (text.length > 3 && text[3] !== '\n')) {
    return { error: 'no front matter' };
  }
  // First find the closing line (the reference reports "not closed" before any line error).
  let pos = text.length === 3 ? 3 : 4;
  let closeStart = -1;
  let closeEnd = -1; // index of the '\n' ending the closing line, or -1
  for (;;) {
    const end = text.indexOf('\n', pos);
    const line = end === -1 ? text.slice(pos) : text.slice(pos, end);
    if (line === '---') { closeStart = pos; closeEnd = end; break; }
    if (end === -1) return { error: 'the front matter is not closed' };
    pos = end + 1;
  }
  const data = {};
  pos = text.length === 3 ? 3 : 4;
  let lineNo = 2;
  while (pos < closeStart) {
    const end = text.indexOf('\n', pos);
    const line = end === -1 ? text.slice(pos) : text.slice(pos, end);
    if (!/^[ \t]*$/.test(line) && !line.startsWith('#')) {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = end === -1 ? text.length : end + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === -1 ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

/** Spaces and tabs at either end dropped. */
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language, or null when `line` does not open a fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) k++;
    else break;
  }
  const lang = line.slice(3, k);
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
    k++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (d >= line.length || (line.charCodeAt(d) !== 32 && line.charCodeAt(d) !== 9)) return null;
  let end = line.length;
  while (end > d && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  let start = d;
  while (start < end && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  if (start >= end) return null;
  return { depth: d, text: line.slice(start, end) };
}

function isHR(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let k = 3; k < line.length; k++) {
    const ch = line.charCodeAt(k);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

/** A list's kind and (for an ordered list) start, from its first line, or null. */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1 };
  let k = 0;
  while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
  if (k >= 1 && k <= 9 && line.charCodeAt(k) === 46 && line.charCodeAt(k + 1) === 32) return { ordered: true, start: Number(line.slice(0, k)) };
  return null;
}

/** A list item's text (before trimming), or null when `line` is not an item of this list's kind. */
function listItem(line, ordered) {
  if (!ordered) {
    const c0 = line.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
    return null;
  }
  let k = 0;
  while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
  if (k >= 1 && k <= 9 && line.charCodeAt(k) === 46 && line.charCodeAt(k + 1) === 32) return line.slice(k + 2);
  return null;
}

/** A continuation line: two or more spaces, then a non-space. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  return !isWS(line.charCodeAt(k));
}

// The one shared scanner for inline text. `inline` is re-entrant (strong, emphasis and link text render
// inline), so every branch restores SPECIAL_RE.lastIndex to the position it consumed before continuing.
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * A run of backslashes escapes the character after it exactly when the run is odd: the reference
 * scans left to right pairing each backslash with the next escapable character, which pairs a run
 * the same way, so only the run's parity matters.
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let n = 0;
    while (k >= 0 && s[k] === '\\') { n++; k--; }
    if (n % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = j - 1;
    let n = 0;
    while (k >= 0 && s[k] === '\\') { n++; k--; }
    if (n % 2 === 1) { j = s.indexOf('*', j + 1); continue; }
    if (s[j + 1] === '*') { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

/** `s` rendered inline, appended to `out`; `link(target)` is a link's href. */
function inline(s, link, out) {
  SPECIAL_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const idx = m.index;
    if (idx > last) out.push(s.slice(last, idx));
    const c = s[idx];
    if (c === '\\') {
      if (idx + 1 < s.length && ESCAPABLE.has(s[idx + 1])) { out.push(ESCAPES[s[idx + 1]] ?? s[idx + 1]); last = idx + 2; }
      else { out.push('\\'); last = idx + 1; }
      SPECIAL_RE.lastIndex = last;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', idx + 1);
      if (j > idx + 1) { out.push('<code>', escapeHtml(s.slice(idx + 1, j)), '</code>'); last = j + 1; }
      else { out.push('`'); last = idx + 1; }
      SPECIAL_RE.lastIndex = last;
      continue;
    }
    if (c === '*') {
      if (s[idx + 1] === '*') {
        const j = findUnescaped(s, '**', idx + 2);
        if (j > idx + 2) {
          out.push('<strong>');
          inline(s.slice(idx + 2, j), link, out);
          out.push('</strong>');
          last = j + 2;
        } else { out.push('**'); last = idx + 2; }
      } else {
        const j = findSingleStar(s, idx + 1);
        if (j > idx + 1) {
          out.push('<em>');
          inline(s.slice(idx + 1, j), link, out);
          out.push('</em>');
          last = j + 1;
        } else { out.push('*'); last = idx + 1; }
      }
      SPECIAL_RE.lastIndex = last;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', idx + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escapeHtml(link(target)), '">');
        inline(s.slice(idx + 1, k), link, out);
        out.push('</a>');
        last = mm + 1;
      } else { out.push('['); last = idx + 1; }
      SPECIAL_RE.lastIndex = last;
      continue;
    }
    out.push(ESCAPES[c]);
    last = idx + 1;
    SPECIAL_RE.lastIndex = last;
  }
  if (last < s.length) out.push(s.slice(last));
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents
 * (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's
 * inline HTML, or ""). Blocks are rendered straight from the lines, with no token array in between.
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  const idNext = new Map();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      // Accumulate the escaped lines and join once, instead of += per line.
      const code = body.map((l) => `${escapeHtml(l)}\n`).join('');
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text, slugCache), ids, idNext);
      const out = [];
      inline(hd.text, link, out);
      const html = out.join('');
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(trimST(l));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else {
        const out = [];
        inline(kept.join('\n'), link, out);
        blocks.push(`<blockquote>\n<p>${out.join('')}</p>\n</blockquote>`);
      }
      continue;
    }
    const lst = listStart(line);
    if (lst !== null) {
      const items = [];
      while (i < n) {
        const item = listItem(lines[i], lst.ordered);
        if (item !== null) { items.push([trimST(item)]); i++; }
        else if (isContinued(lines[i])) { items[items.length - 1].push(trimST(lines[i])); i++; }
        else break;
      }
      const tag = lst.ordered ? 'ol' : 'ul';
      const open = lst.ordered && lst.start !== 1 ? `<ol start="${lst.start}">` : `<${tag}>`;
      // Accumulate the items and join once, instead of += per item.
      const innerParts = [];
      for (const parts of items) {
        const out = [];
        inline(parts.join('\n'), link, out);
        innerParts.push(`<li>${out.join('')}</li>\n`);
      }
      blocks.push(`${open}\n${innerParts.join('')}</${tag}>`);
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const out = [];
    inline(body.join('\n'), link, out);
    const html = out.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The names `nodes` reads from its enclosing scope: every path's first name, except names a `for`
 * inside the nodes binds itself (`loop` and its element name), and except names read only through
 * an include that binds them. Includes contribute the included template's own read names, with the
 * names bound at the include site still in force (a cycle contributes nothing new).
 */
function readSetOf(nodes, templates, bound, stack) {
  const out = new Set();
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') { if (!bound.has(n.path[0])) out.add(n.path[0]); }
    else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      for (const x of readSetOf(n.then, templates, bound, stack)) out.add(x);
      if (n.else !== null) for (const x of readSetOf(n.else, templates, bound, stack)) out.add(x);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      for (const x of readSetOf(n.body, templates, inner, stack)) out.add(x);
    } else if (n.kind === 'include') {
      const t = templates.get(n.name);
      if (t !== undefined && !stack.has(n.name)) {
        stack.add(n.name);
        for (const x of readSetOf(t, templates, bound, stack)) out.add(x);
        stack.delete(n.name);
      }
    }
  }
  return out;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ---------------------------------------------------------------- rendering

/**
 * A memo key for rendering an included template: its name, the include depth, and the values its
 * read names resolve to in the current scope. Two renders with the same key read the same values
 * at every path the template (and everything it includes) can reach, and run at the same include
 * depth, so they render the same string. Values are keyed by object identity (objects are never
 * mutated during a build) or by their literal text. A fresh `loop` object per iteration simply
 * never hits, which is correct, never wrong.
 */
function memoKey(name, readSet, scope, depth, ctx) {
  let key = `${name}\n${depth}`;
  for (const nm of readSet) {
    const v = lookup(scope, [nm]);
    key += `\n${nm}=`;
    if (v === undefined) key += 'u';
    else if (v === null) key += 'n';
    else if (typeof v === 'string') key += `s${JSON.stringify(v)}`;
    else if (typeof v === 'number') key += `#${v}`;
    else if (typeof v === 'boolean') key += `b${v ? '1' : '0'}`;
    else {
      let id = ctx.objIds.get(v);
      if (id === undefined) { id = ctx.nextObjId++; ctx.objIds.set(v, id); }
      key += `o${id}`;
    }
  }
  return key;
}

/** `nodes` rendered into `out` (an array of strings, joined by the caller). */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (Array.isArray(xs)) {
          for (let k = 0; k < xs.length; k++) {
            const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
            renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
          }
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) {
          const key = memoKey(n.name, t.readSet, scope, depth, ctx);
          const hit = ctx.memo.get(key);
          if (hit !== undefined) { out.push(hit); break; }
          const sub = [];
          renderNodes(t.nodes, scope, ctx, depth + 1, sub);
          const s = sub.join('');
          ctx.memo.set(key, s);
          out.push(s);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory parts `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = [...dirParts];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function isScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let k = 1;
  while (k < target.length) {
    const c = target.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) k++;
    else break;
  }
  return k < target.length && target.charCodeAt(k) === 58;
}

/** One site's output tree: path -> text. */
export function build(input) {
  // Per-case caches: nothing here survives into the next case.
  const slugCache = new Map();
  const dateCache = new Map();
  const resolveCache = new Map(); // dir -> Map rel -> { u: url } | null

  // 2. Templates, parsed in code-unit order of their name. One that does not parse is reported and left out.
  const nodesMap = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      nodesMap.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const templates = new Map();
  for (const [name, nodes] of nodesMap) {
    templates.set(name, { nodes, readSet: readSetOf(nodes, nodesMap, new Set(), new Set([name])) });
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order; the checks run in the reference's order, the first failure reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  sources = kept;

  // Permalinks: each page's slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    let t = taken.get(dir);
    if (t === undefined) {
      t = { set: new Set(dir === '' ? RESERVED : []), next: new Map() };
      taken.set(dir, t);
    }
    return t;
  };
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const t = takenIn(dir);
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), t.set, t.next);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    let byDir = resolveCache.get(dir);
    if (byDir === undefined) { byDir = new Map(); resolveCache.set(dir, byDir); }
    const link = (target) => {
      if (isScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      if (!byDir.has(rel)) {
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        byDir.set(rel, path === null ? null : bySource.has(path) ? { u: bySource.get(path).url } : staticPaths.has(path) ? { u: `${base}/${path}` } : null);
      }
      const res = byDir.get(rel);
      if (res !== null) return `${res.u}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const sl = slugify(name, slugCache);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of sources) s.card = cardOf(s);
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache) });
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  for (const t of tags) t.view = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) };

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const ctx = { templates, memo: new Map(), objIds: new WeakMap(), nextObjId: 1 };
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    const out = [];
    renderNodes(t.nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: t.view });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
