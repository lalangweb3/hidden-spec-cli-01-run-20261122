// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// mend reads a patch in one of four formats -- a unified diff (often with
// wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, or
// text-editor tool calls as JSON -- finds the lines each edit names at the
// first of three matching tiers, and changes every file or none.
//
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line on stdout, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, does not start with /, holds no backslash, and none of its segments is empty, . or .. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file split into lines: its line break, its lines, and whether it ends with a break. */
interface FileState {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function renderFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBr ? s.br : '');
}

/** SPEC.md section 5: one line normalised at a tier. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimEndWs(s);
  return trimBothWs(s);
}

/** Every 0-based position where `old` occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], old: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > lines.length) return out;
  // Normalise each side once per tier instead of once per comparison.
  const nl = lines.map((l) => normLine(l, tier));
  const no = old.map((l) => normLine(l, tier));
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (nl[i + j] !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which `old` occurs at least once, with its positions. */
function findMatch(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  for (const t of tiersToTry(strict)) {
    const at = occurrences(lines, old, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of an old block (O) or a new block (N). A context line is written as the file's own matched line. */
interface OLine {
  text: string;
  ctx: boolean;
}
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/**
 * The lines that replace a match: context lines as the file's own matched
 * lines, other lines re-indented at tier 2 (SPEC.md section 5).
 */
function buildNew(fileLines: string[], at: number, o: OLine[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(fileLines[at]!);
    p = leadWs(o[0]!.text);
  }
  for (const e of n) {
    if (e.ctx) {
      out.push(fileLines[at + e.oIdx]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Shared state for one run: --strict, and the moves that succeeded, for the R lines. */
interface Ctx {
  strict: boolean;
  moves: { old: string; nw: string }[];
}

type Edit = (tree: Tree) => void;

/** SPEC.md section 4: detect the format, or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const st = parseFile(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      const lines = [...st.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile({ lines, br: st.br, finalBr: st.finalBr }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  hasPair: boolean;
  oldPath: string | null;
  newPath: string | null;
  diffOld: string | null;
  diffNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, surrounding spaces removed; /dev/null means no file. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkHeader(line: string, idx: number): Hunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  return { a: Number(m[1]), body: [] };
}

/** A hunk body's old and new lines, and whether a `\` line follows its last context or `+` line. */
function hunkON(body: string[]): { o: OLine[]; n: NLine[]; backslash: boolean } {
  const o: OLine[] = [];
  const n: NLine[] = [];
  let lastCtxPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      const oi = o.length;
      o.push({ text: t, ctx: true });
      n.push({ text: t, ctx: true, oIdx: oi });
      lastCtxPlus = k;
    } else if (l.startsWith('-')) {
      o.push({ text: l.slice(1), ctx: false });
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      lastCtxPlus = k;
    } else if (l === '') {
      const oi = o.length;
      o.push({ text: '', ctx: true });
      n.push({ text: '', ctx: true, oIdx: oi });
      lastCtxPlus = k;
    }
    // `\` lines refer to the body line before them; only the one after the
    // last context or `+` line changes the file's final break.
  }
  const backslash = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]!.startsWith('\\');
  return { o, n, backslash };
}

/** Apply a section's hunks in order to a file's state. */
function applyHunks(state: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let lines = state.lines;
  let finalBr = state.finalBr;
  let d = 0;
  for (const h of hunks) {
    const { o, n, backslash } = hunkON(h.body);
    if (o.length > 0) {
      const found = findMatch(lines, o.map((e) => e.text), strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.at[0]!;
      let bestDist = Math.abs(best - target);
      for (const at of found.at) {
        const dist = Math.abs(at - target);
        if (dist < bestDist) {
          best = at;
          bestDist = dist;
        }
      }
      const rep = buildNew(lines, best, o, n, found.tier);
      const toEnd = best + o.length === lines.length;
      lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
      if (toEnd) finalBr = !backslash;
      d += n.length - o.length;
    } else {
      const insertAt = Math.min(h.a + d, lines.length);
      const add = n.map((e) => e.text);
      const atEnd = insertAt === lines.length;
      lines = [...lines.slice(0, insertAt), ...add, ...lines.slice(insertAt)];
      if (atEnd) finalBr = !backslash;
      d += n.length;
    }
  }
  return { lines, br: state.br, finalBr };
}

function applyUnified(tree: Tree, s: UniSection, ctx: Ctx): void {
  let oldP: string | null;
  let newP: string | null;
  if (s.hasPair) {
    oldP = s.oldPath;
    newP = s.newPath;
  } else if (s.renameFrom !== null || s.renameTo !== null) {
    oldP = s.renameFrom ?? s.diffOld ?? s.renameTo;
    newP = s.renameTo ?? s.diffNew ?? s.renameFrom;
  } else {
    oldP = s.diffOld;
    newP = s.diffNew;
  }
  if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
  if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
  if (oldP === null || s.newFile) {
    // Creation: the new path does not exist; the file is the `+` lines of all its hunks.
    const p = newP ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    const plus: string[] = [];
    let lastPlus: { body: string[]; idx: number } | null = null;
    for (const h of s.hunks) {
      for (let k = 0; k < h.body.length; k++) {
        if (h.body[k]!.startsWith('+')) {
          plus.push(h.body[k]!.slice(1));
          lastPlus = { body: h.body, idx: k };
        }
      }
    }
    let finalBr = true;
    if (lastPlus !== null && lastPlus.idx + 1 < lastPlus.body.length && lastPlus.body[lastPlus.idx + 1]!.startsWith('\\')) finalBr = false;
    tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBr ? '\n' : ''));
    return;
  }
  if (newP === null || s.deletedFile) {
    // Deletion: the old path exists; it is deleted, and its hunks are not read.
    const p = oldP;
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  if (oldP !== newP) {
    // Move: the old path exists, the new path does not; hunks apply to the old file.
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    if (tree.get(newP) !== null) throw new Fail('exists', newP);
    const res = applyHunks(parseFile(tree.get(oldP)!), s.hunks, ctx.strict, oldP);
    tree.now.set(newP, renderFile(res));
    tree.now.set(oldP, null);
    ctx.moves.push({ old: oldP, nw: newP });
    return;
  }
  // Change of the one path, which exists.
  if (tree.get(oldP) === null) throw new Fail('missing', oldP);
  const res = applyHunks(parseFile(tree.get(oldP)!), s.hunks, ctx.strict, oldP);
  tree.now.set(oldP, renderFile(res));
}

function parseUnified(lines: string[], ctx: Ctx): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let i = 0;
  const newSection = (): UniSection => ({
    hasPair: false,
    oldPath: null,
    newPath: null,
    diffOld: null,
    diffNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  // Read one hunk body starting at j: lines starting with ` `, `-`, `+`, `\`, or empty.
  const readBody = (j0: number): { body: string[]; next: number } => {
    let j = j0;
    const body: string[] = [];
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l.startsWith('@@')) break;
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
        body.push(l);
        j++;
        continue;
      }
      break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    return { body, next: j };
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) {
        cur.hasPair = true;
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
      } else {
        cur = newSection();
        cur.hasPair = true;
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (cur.hunks.length === 0) {
      // Section header: a `--- ` line not followed by `+++ ` is a parse error at the line after it.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('@@')) {
        const h = parseHunkHeader(line, i);
        const r = readBody(i + 1);
        h.body = r.body;
        cur.hunks.push(h);
        i = r.next;
        continue;
      }
      if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const h = parseHunkHeader(line, i);
      const r = readBody(i + 1);
      h.body = r.body;
      cur.hunks.push(h);
      i = r.next;
      continue;
    }
    i++;
  }
  const edits: Edit[] = sections.map((s) => (tree) => applyUnified(tree, s, ctx));
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function applySR(tree: Tree, b: SRBlock, strict: boolean): void {
  const p = b.path;
  if (!safe(p)) throw new Fail('unsafe', p);
  if (b.oldLines.length === 0) {
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
    return;
  }
  const cur = tree.get(p);
  if (cur === null) throw new Fail('missing', p);
  const st = parseFile(cur);
  const o: OLine[] = b.oldLines.map((t) => ({ text: t, ctx: false }));
  const n: NLine[] = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
  const found = findMatch(st.lines, b.oldLines, strict);
  if (found === null) throw new Fail('no-match', p);
  if (found.at.length > 1) throw new Fail('ambiguous', p);
  const at = found.at[0]!;
  const rep = buildNew(st.lines, at, o, n, found.tier);
  const lines = [...st.lines.slice(0, at), ...rep, ...st.lines.slice(at + o.length)];
  tree.now.set(p, renderFile({ lines, br: st.br, finalBr: st.finalBr }));
}

function parseSearchReplace(lines: string[], ctx: Ctx): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let k = searchIdx + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '=======') {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchIdx + 1}`);
      k++;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const eqIdx = k;
    let m = eqIdx + 1;
    while (m < lines.length && lines[m]!.trimEnd() !== '>>>>>>> REPLACE') m++;
    if (m >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eqIdx), newLines: lines.slice(eqIdx + 1, m) });
    prevPath = path;
    prevEnd = m + 1;
    i = m + 1;
  }
  const edits: Edit[] = blocks.map((b) => (tree) => applySR(tree, b, ctx.strict));
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string;
  body: string[];
  eof: boolean;
}

/** A chunk body's old and new lines. */
function chunkON(body: string[]): { o: OLine[]; n: NLine[] } {
  const o: OLine[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      const oi = o.length;
      o.push({ text: t, ctx: true });
      n.push({ text: t, ctx: true, oIdx: oi });
    } else if (l.startsWith('-')) {
      o.push({ text: l.slice(1), ctx: false });
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
    } else if (l === '') {
      const oi = o.length;
      o.push({ text: '', ctx: true });
      n.push({ text: '', ctx: true, oIdx: oi });
    }
  }
  return { o, n };
}

function applyV4AUpdate(tree: Tree, path: string, moveTo: string | null, chunks: VChunk[], ctx: Ctx): void {
  if (!safe(path)) throw new Fail('unsafe', path);
  const cur = tree.get(path);
  if (cur === null) throw new Fail('missing', path);
  if (moveTo !== null) {
    if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
    if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
  }
  const st = parseFile(cur);
  let lines = st.lines;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== '') {
      let foundAt: number | null = null;
      for (const t of tiersToTry(ctx.strict)) {
        // Normalise the anchor once per tier instead of once per line.
        const want = normLine(ch.anchor, t);
        for (let j = cursor; j < lines.length; j++) {
          if (normLine(lines[j]!, t) === want) {
            foundAt = j;
            break;
          }
        }
        if (foundAt !== null) break;
      }
      if (foundAt === null) throw new Fail('no-match', path);
      cursor = foundAt + 1;
    }
    const { o, n } = chunkON(ch.body);
    if (o.length > 0) {
      let found: { tier: number; at: number } | null = null;
      for (const t of tiersToTry(ctx.strict)) {
        let at = occurrences(lines, o.map((e) => e.text), t, cursor);
        if (ch.eof) at = at.filter((a) => a + o.length === lines.length);
        if (at.length > 0) {
          found = { tier: t, at: at[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const rep = buildNew(lines, found.at, o, n, found.tier);
      lines = [...lines.slice(0, found.at), ...rep, ...lines.slice(found.at + o.length)];
      cursor = found.at + rep.length;
    } else {
      const insertAt = ch.eof ? lines.length : cursor;
      const add = n.map((e) => e.text);
      lines = [...lines.slice(0, insertAt), ...add, ...lines.slice(insertAt)];
      cursor = insertAt + add.length;
    }
  }
  const content = renderFile({ lines, br: st.br, finalBr: st.finalBr });
  if (moveTo !== null) {
    tree.now.set(moveTo, content);
    tree.now.set(path, null);
    ctx.moves.push({ old: path, nw: moveTo });
  } else {
    tree.now.set(path, content);
  }
}

function parseV4A(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!isHeader(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = line.startsWith('*** Add') ? 'add' : line.startsWith('*** Delete') ? 'delete' : 'update';
    const path = line.slice(kind === 'add' ? 14 : 17).trim();
    let j = i + 1;
    const raw: string[] = [];
    while (j < last && !isHeader(lines[j]!)) {
      raw.push(lines[j]!);
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let rest = raw;
      if (rest.length > 0 && rest[0]!.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.slice(13).trim();
        rest = rest.slice(1);
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (let k = 0; k < rest.length; k++) {
        const l = rest[k]!;
        const ln = i + 2 + (moveTo !== null ? 1 : 0) + k;
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: l.slice(2).trim(), body: [], eof: false };
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
            cur = { anchor: '', body: [], eof: false };
          }
          cur.body.push(l);
        } else {
          throw new Exit2(`error: parse ${ln}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => applyV4AUpdate(tree, path, moveTo, chunks, ctx));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Run (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, ctx);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, ctx);
    else edits = parseV4A(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = ctx.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of ctx.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.nw);
    const nowNew = tree.get(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
      covered.add(m.old);
      covered.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
