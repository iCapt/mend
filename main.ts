// mend — one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A patch, JSON text-editor calls) and applies it to the files
// it names. Every edit is matched at the first of three tiers:
//   tier 0 — the lines match exactly;
//   tier 1 — trailing spaces and tabs are ignored;
//   tier 2 — leading and trailing spaces and tabs are ignored.
// All edits are applied in memory; files are only written when every
// edit succeeds, so a patch changes every file or none.
//
// Node 22, standard library only, deterministic output.

import { mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------- errors

// A malformed patch: the printed line number is where the format broke.
class ParseErr {
  readonly at: number;
  constructor(at: number) {
    this.at = at;
  }
}

// One edit that could not be applied. `code` is the word printed after
// "error: " and `path` the file the edit names.
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// ------------------------------------------------------------ text helpers

const isBlank = (line: string): boolean => line.trim() === '';

// The patch text as lines. The piece after a final line break is not a
// line, so a patch ending with "\n" does not gain an empty line.
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// A line break inside a file. The file is CRLF when the first line feed
// in it follows a carriage return; every other file is LF.
function fileBreak(text: string): '\r\n' | '\n' {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

// Split a file's text into the lines it holds, keeping a note of whether
// it ends with a line break. An empty file holds no lines and ends with
// no break; any non-empty file ending in a break has one extra empty
// line after its last break, and that line is not part of the file.
function splitFile(text: string): { lines: string[]; final: boolean } {
  const br = fileBreak(text);
  const raw = text.split(br);
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return { lines: raw, final: text.length > 0 && text.endsWith(br) };
}

function joinFile(lines: string[], br: '\r\n' | '\n', final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// A path is safe when it is not empty, does not start with "/", has no
// backslash, and none of its "/" segments is empty, "." or "..".
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// Byte order, as in a directory listing. Used to sort changed paths.
function byteLess(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ------------------------------------------------------------- file store

// The tree of files, read lazily from disk and changed only in memory
// until the whole patch has been applied.
class Tree {
  private orig: Map<string, string | null> = new Map();
  readonly now: Map<string, string | null> = new Map();

  get(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p) ?? null;
    return this.original(p);
  }

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let text: string | null = null;
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        text = null;
      }
      this.orig.set(p, text);
    }
    return this.orig.get(p) ?? null;
  }

  put(p: string, text: string | null): void {
    this.now.set(p, text);
  }
}

// ------------------------------------------------------------- doc model

// A file as lines plus its line break and whether it ends with one.
interface Doc {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function readDoc(text: string): Doc {
  const br = fileBreak(text);
  const { lines, final } = splitFile(text);
  return { lines, br, final };
}

function writeDoc(doc: Doc): string {
  return joinFile(doc.lines, doc.br, doc.final);
}

// ------------------------------------------------------------- matching

// The three matching tiers. Tier 0 compares a line as it is; tier 1
// ignores trailing spaces and tabs; tier 2 ignores them on both sides.
function tiered(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// The 0-based positions where `old` matches `lines` exactly at `tier`.
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const hits: number[] = [];
  const first = tiered(old[0], tier);
  for (let i = 0; i + old.length <= lines.length; i++) {
    if (tiered(lines[i], tier) !== first) continue;
    let ok = true;
    for (let j = 1; j < old.length; j++) {
      if (tiered(lines[i + j], tier) !== tiered(old[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

// The first tier at which `old` matches `lines` at all, plus every
// position it matches there. With `strict` only tier 0 is tried.
function firstMatch(lines: string[], old: string[], strict: boolean): { tier: number; at: number[] } | null {
  const top = strict ? 1 : 3;
  for (let tier = 0; tier < top; tier++) {
    const at = occurrences(lines, old, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

// One line of a replacement. `ctx` names the position of the matching
// old line this line follows unchanged, or null when it is new text.
interface NewLine {
  text: string;
  ctx: number | null;
}

// Render replacement lines for an edit matched at `tier`. A context
// line is written as the file's own matched line, never the patch's.
// At tier 2 every other line is re-indented: let F be the leading
// spaces and tabs of the file's first matched line and P those of O's
// first line; a line that is not empty and not only whitespace, and
// starts with P, has that P replaced by F. At tiers 0 and 1 the lines
// of N are written as they are.
function renderNew(newLines: NewLine[], old: string[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const f = fileLines[pos].match(/^[ \t]*/)?.[0] ?? '';
  const p = old[0].match(/^[ \t]*/)?.[0] ?? '';
  for (const nl of newLines) {
    if (nl.ctx !== null) {
      out.push(fileLines[pos + nl.ctx]);
      continue;
    }
    const text = nl.text;
    if (tier !== 2) {
      out.push(text);
      continue;
    }
    if (text === '' || text.trim() === '') {
      out.push(text);
      continue;
    }
    if (text.startsWith(p)) out.push(f + text.slice(p.length));
    else out.push(text);
  }
  return out;
}

// ------------------------------------------------------------------- edits

// A move record: a file that existed at `old` and now exists at `next`.
// Used to print one "R" line instead of an "A" and a "D" line.
interface Move {
  old: string;
  next: string;
}

// One edit of the tree. `moves` is shared by the whole run.
type Edit = (tree: Tree, moves: Move[]) => void;

// A body line of a unified or V4A hunk: `mark` is " ", "-", "+" or "\"
// and `text` is what follows the mark (an empty line is " " with "").
interface BodyLine {
  mark: string;
  text: string;
}

// The old lines a hunk removes and the new lines it writes, with the
// context lines linked to the old lines they follow unchanged.
function hunkOldNew(items: BodyLine[]): { old: string[]; newLines: NewLine[] } {
  const old: string[] = [];
  const newLines: NewLine[] = [];
  for (const it of items) {
    if (it.mark === ' ') {
      old.push(it.text);
      newLines.push({ text: it.text, ctx: old.length - 1 });
    } else if (it.mark === '-') {
      old.push(it.text);
    } else if (it.mark === '+') {
      newLines.push({ text: it.text, ctx: null });
    }
  }
  return { old, newLines };
}

// A "\" line follows the last context or "+" line when one is present.
function backslashAfterLast(items: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].mark === ' ' || items[i].mark === '+') last = i;
  }
  if (last < 0) return false;
  return items[last + 1]?.mark === '\\';
}

// Apply a hunk whose old lines are not empty. The position chosen is
// the nearest occurrence to `target` (the earlier one on a tie).
function applyHunk(doc: Doc, items: BodyLine[], target: number, strict: boolean, path: string): number {
  const { old, newLines } = hunkOldNew(items);
  const found = firstMatch(doc.lines, old, strict);
  if (!found) throw new EditFail('no-match', path);
  let pos = found.at[0];
  for (const p of found.at) {
    if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
  }
  const atEnd = pos + old.length === doc.lines.length;
  const replacement = renderNew(newLines, old, doc.lines, pos, found.tier);
  doc.lines.splice(pos, old.length, ...replacement);
  if (atEnd) doc.final = !backslashAfterLast(items);
  return newLines.length - old.length;
}

// ------------------------------------------------------ format detection

type Format = 'unified' | 'search-replace' | 'v4a' | 'json';

function detectFormat(lines: string[]): Format | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ------------------------------------------------------------ json edits

// Build the edit one JSON object describes, or null when it describes
// no edit at all. All four fields are checked for presence and type.
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const path = o.path;
  if (typeof path !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree: Tree) => {
      if (!safePath(path)) throw new EditFail('unsafe', path);
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.put(path, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree: Tree) => {
      if (!safePath(path)) throw new EditFail('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new EditFail('missing', path);
      const crlf = readDoc(before).br === '\r\n';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const body = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = body.indexOf(old); k >= 0; k = body.indexOf(old, k + 1)) count++;
      if (count === 0) throw new EditFail('no-match', path);
      if (count > 1) throw new EditFail('ambiguous', path);
      const at = body.indexOf(old);
      const out = body.slice(0, at) + toLf(newStr) + body.slice(at + old.length);
      tree.put(path, crlf ? out.split('\n').join('\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    // The new text's lines: split at \n, each with one trailing \r
    // removed, without the empty piece after a final \n.
    const parts = o.new_str.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    const add = parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
    return (tree: Tree) => {
      if (!safePath(path)) throw new EditFail('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new EditFail('missing', path);
      const doc = readDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new EditFail('no-match', path);
      doc.lines.splice(lineNo, 0, ...add);
      tree.put(path, writeDoc(doc));
    };
  }
  return null;
}

// Parse a JSON patch: one array, or one object per non-blank line.
function parseJsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr(1);
  if (lines[first].trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(value)) throw new ParseErr(first + 1);
    const edits: Edit[] = [];
    for (const item of value) {
      const e = jsonEditObject(item);
      if (!e) throw new ParseErr(first + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseErr(1);
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((line, i) => {
    if (isBlank(line)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(line));
    } catch {
      e = null;
    }
    if (!e) throw new ParseErr(i + 1);
    edits.push(e);
  });
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------------------------------------------------------- unified diff

interface UnifiedHunk {
  start: number;
  items: BodyLine[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  make: boolean;
  remove: boolean;
  rename: boolean;
  hunks: UnifiedHunk[];
}

const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// The path named by a `--- ` or `+++ ` line: the text after the four
// characters, up to the first tab, with surrounding spaces removed; a
// leading a/ or b/ is removed. `/dev/null` means no file.
function unifiedPath(line: string): string {
  const raw = line.slice(4).split('\t')[0].trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

// The two paths of a `diff --git a/<X> b/<Y>` line, or null when the
// line is not of that form.
function diffGitPaths(line: string): { old: string; next: string } | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const cut = rest.indexOf(' b/', 2);
  if (cut < 0) return null;
  const old = rest.slice(2, cut);
  const next = rest.slice(cut + 3);
  if (old === '' || next === '') return null;
  return { old, next };
}

function parseUnified(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let sec: UnifiedSection | null = null;
  let hunks: UnifiedHunk[] = [];
  let hunk: UnifiedHunk | null = null;
  let state: 'out' | 'header' | 'body' = 'out';

  const endHunk = (): void => {
    if (!hunk) return;
    while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1].mark === ' ' && hunk.items[hunk.items.length - 1].text === '') {
      hunk.items.pop();
    }
    hunks.push(hunk);
    hunk = null;
  };
  const endSection = (): void => {
    endHunk();
    if (sec) {
      sec.hunks = hunks;
      sections.push(sec);
      sec = null;
      hunks = [];
    }
  };
  const startSection = (diffOld?: string, diffNew?: string): void => {
    endSection();
    sec = { oldPath: diffOld ?? null, newPath: diffNew ?? null, make: false, remove: false, rename: false, hunks: [] };
    state = 'header';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';
    if (line.startsWith('diff --git ')) {
      const dg = diffGitPaths(line);
      if (!dg) throw new ParseErr(i + 1);
      startSection(dg.old, dg.next);
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      if (state === 'header' && sec) {
        // Part of this section's header: it names its paths.
        sec.oldPath = unifiedPath(line);
        sec.newPath = unifiedPath(next);
      } else {
        startSection();
        sec!.oldPath = unifiedPath(line);
        sec!.newPath = unifiedPath(next);
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(hunkHead);
      if (!m) throw new ParseErr(i + 1);
      if (!sec) throw new ParseErr(i + 1);
      endHunk();
      hunk = { start: Number(m[1]), items: [] };
      state = 'body';
      continue;
    }
    if (state === 'out') {
      // Prose, code fences and lone lines are ignored.
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('--- ')) {
        // Not followed by a +++ line (the pair case is above).
        throw new ParseErr(i + 2);
      } else if (line.startsWith('+++ ')) {
        sec!.newPath = unifiedPath(line);
      } else if (line.startsWith('new file mode')) {
        sec!.make = true;
      } else if (line.startsWith('deleted file mode')) {
        sec!.remove = true;
      } else if (line.startsWith('rename from ')) {
        sec!.rename = true;
        if (sec!.oldPath === null) sec!.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        sec!.rename = true;
        if (sec!.newPath === null) sec!.newPath = line.slice('rename to '.length).trim();
      }
      continue;
    }
    // state === 'body'
    if (!hunk) throw new ParseErr(i + 1);
    if (line === '') {
      hunk.items.push({ mark: ' ', text: '' });
    } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
      hunk.items.push({ mark: line[0], text: line.slice(1) });
    } else {
      state = 'out';
      i--;
    }
  }
  endSection();

  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.hunks.length === 0 && !s.make && !s.remove && !s.rename) continue;
    const isCreate = s.oldPath === '/dev/null' || s.make;
    const isDelete = s.newPath === '/dev/null' || s.remove;
    if (isCreate && s.newPath !== null) {
      // A creation: the file is the + lines of all its hunks, in
      // order, and ends with a line break unless a \ line follows
      // its last + line.
      const path = s.newPath;
      const hs = s.hunks;
      edits.push((tree: Tree) => {
        if (!safePath(path)) throw new EditFail('unsafe', path);
        if (tree.get(path) !== null) throw new EditFail('exists', path);
        const made: string[] = [];
        for (const h of hs) {
          for (const it of h.items) {
            if (it.mark === '+') made.push(it.text);
          }
        }
        let fin = false;
        for (let k = hs.length - 1; k >= 0; k--) {
          if (hs[k].items.some((it) => it.mark === '+')) {
            fin = !backslashAfterLast(hs[k].items);
            break;
          }
        }
        const doc: Doc = { lines: made, br: '\n', final: fin };
        tree.put(path, writeDoc(doc));
      });
      continue;
    }
    if (isDelete && s.oldPath !== null) {
      const path = s.oldPath;
      edits.push((tree: Tree) => {
        if (!safePath(path)) throw new EditFail('unsafe', path);
        if (tree.get(path) === null) throw new EditFail('missing', path);
        tree.put(path, null);
      });
      continue;
    }
    if (s.oldPath !== null && s.newPath !== null && s.oldPath !== s.newPath) {
      const from = s.oldPath;
      const to = s.newPath;
      const copyHs: UnifiedHunk[] = s.hunks.map((h) => ({ start: h.start, items: h.items }));
      edits.push((tree: Tree, mv: Move[]) => {
        if (!safePath(from)) throw new EditFail('unsafe', from);
        if (!safePath(to)) throw new EditFail('unsafe', to);
        const before = tree.get(from);
        if (before === null) throw new EditFail('missing', from);
        if (tree.get(to) !== null) throw new EditFail('exists', to);
        const doc = readDoc(before);
        let d = 0;
        for (const h of copyHs) {
          const { old } = hunkOldNew(h.items);
          if (old.length === 0) {
            const ins = Math.max(0, Math.min(h.start + d, doc.lines.length));
            const atEnd = ins === doc.lines.length;
            const add = h.items.filter((it) => it.mark === '+').map((it) => it.text);
            doc.lines.splice(ins, 0, ...add);
            if (atEnd) doc.final = !backslashAfterLast(h.items);
            d += add.length;
          } else {
            d += applyHunk(doc, h.items, h.start - 1 + d, strict, from);
          }
        }
        tree.put(from, null);
        tree.put(to, writeDoc(doc));
        mv.push({ old: from, next: to });
      });
      continue;
    }
    const path = s.newPath ?? s.oldPath;
    if (path === null) continue;
    const copyHs: UnifiedHunk[] = s.hunks.map((h) => ({ start: h.start, items: h.items }));
    edits.push((tree: Tree) => {
      if (!safePath(path)) throw new EditFail('unsafe', path);
      const before = tree.get(path);
      if (before === null) throw new EditFail('missing', path);
      const doc = readDoc(before);
      let d = 0;
      for (const h of copyHs) {
        const { old } = hunkOldNew(h.items);
        if (old.length === 0) {
          const ins = Math.max(0, Math.min(h.start + d, doc.lines.length));
          const atEnd = ins === doc.lines.length;
          const add = h.items.filter((it) => it.mark === '+').map((it) => it.text);
          doc.lines.splice(ins, 0, ...add);
          if (atEnd) doc.final = !backslashAfterLast(h.items);
          d += add.length;
        } else {
          d += applyHunk(doc, h.items, h.start - 1 + d, strict, path);
        }
      }
      tree.put(path, writeDoc(doc));
    });
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ------------------------------------------------------- search / replace

// One SEARCH/REPLACE block: the path line that names its file, the
// lines to replace, the lines to write in their place, and the lines
// of the patch it spans (1-based SEARCH line, 0-based REPLACE line).
interface SrBlock {
  path: string;
  old: string[];
  newText: string[];
  searchLine: number;
  replaceIdx: number;
}

function parseSearchReplace(lines: string[], strict: boolean, _moves: Move[]): Edit[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = lines.findIndex((l, k) => k >= i && l.trimEnd() === '<<<<<<< SEARCH');
    if (start < 0) break;
    const searchLine = start + 1;
    // The path is the nearest usable line before SEARCH, after the
    // previous block's REPLACE line (or the start of the patch).
    const from = blocks.length > 0 ? blocks[blocks.length - 1].replaceIdx + 1 : 0;
    let path: string | null = null;
    for (let k = start - 1; k >= from; k--) {
      const t = lines[k].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    // With no path line the block takes the previous block's path;
    // the first block with none is a parse error.
    if (path === null) {
      if (blocks.length === 0) throw new ParseErr(searchLine);
      path = blocks[blocks.length - 1].path;
    }
    const sep = lines.findIndex((l, k) => k > start && l.trimEnd() === '=======');
    const end = lines.findIndex((l, k) => k > start && l.trimEnd() === '>>>>>>> REPLACE');
    if (sep < 0 || end < 0 || sep > end) throw new ParseErr(searchLine);
    blocks.push({
      path,
      old: lines.slice(start + 1, sep),
      newText: lines.slice(sep + 1, end),
      searchLine,
      replaceIdx: end,
    });
    i = end + 1;
  }
  if (blocks.length === 0) throw new ParseErr(1);
  const edits: Edit[] = blocks.map((b) => {
    const path = b.path;
    const oldLines = b.old;
    const newLines = b.newText;
    return (tree: Tree) => {
      if (!safePath(path)) throw new EditFail('unsafe', path);
      const before = tree.get(path);
      if (oldLines.length === 0) {
        // A creation: the file must not exist yet.
        if (before !== null) throw new EditFail('exists', path);
        const body: Doc = { lines: [...newLines], br: '\n', final: newLines.length > 0 };
        tree.put(path, writeDoc(body));
        return;
      }
      if (before === null) throw new EditFail('missing', path);
      const doc = readDoc(before);
      const found = firstMatch(doc.lines, oldLines, strict);
      if (!found) throw new EditFail('no-match', path);
      if (found.at.length > 1) throw new EditFail('ambiguous', path);
      const pos = found.at[0];
      const nl: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
      const replacement = renderNew(nl, oldLines, doc.lines, pos, found.tier);
      doc.lines.splice(pos, oldLines.length, ...replacement);
      tree.put(path, writeDoc(doc));
    };
  });
  return edits;
}

// ---------------------------------------------------------------------- v4a

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  fileLines: string[];
  chunks: VChunk[];
  updateLine: number;
}

function parseV4a(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last])) last--;
  if (last < 0 || lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const body = lines.slice(first + 1, last);

  const sections: VSection[] = [];
  let i = 0;
  const headRe = /^\*\*\* (Add File|Delete File|Update File): (.+)$/;
  while (i < body.length) {
    const line = body[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const m = line.match(headRe);
    if (!m) throw new ParseErr(first + 2 + i);
    const kind = m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update';
    const path = m[2].trim();
    const updateLine = first + 2 + i;
    i++;
    const sec: VSection = { kind, path, moveTo: null, fileLines: [], chunks: [], updateLine };
    if (kind === 'add') {
      // An Add section's lines start with + (the rest is a line of
      // the file) or are empty (an empty line of the file). Blank
      // lines at the end of the section are not part of it.
      const raw: string[] = [];
      const rawStart = i;
      while (i < body.length && !body[i].match(headRe) && body[i].trim() !== '*** End Patch') {
        raw.push(body[i]);
        i++;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      raw.forEach((r, k) => {
        if (r.startsWith('+')) sec.fileLines.push(r.slice(1));
        else if (r === '') sec.fileLines.push('');
        else throw new ParseErr(first + 2 + rawStart + k);
      });
    } else if (kind === 'delete') {
      while (i < body.length && !body[i].match(headRe) && body[i].trim() !== '*** End Patch') {
        if (!isBlank(body[i])) throw new ParseErr(first + 2 + i);
        i++;
      }
    } else {
      let chunk: VChunk | null = null;
      let started = false;
      const finish = (strip: boolean): void => {
        if (!chunk) return;
        if (strip) {
          while (chunk.items.length > 0 && chunk.items[chunk.items.length - 1].mark === ' ' && chunk.items[chunk.items.length - 1].text === '') {
            chunk.items.pop();
          }
        }
        sec.chunks.push(chunk);
        chunk = null;
      };
      while (i < body.length && !body[i].match(headRe) && body[i].trim() !== '*** End Patch') {
        const l = body[i];
        if (l.startsWith('*** Move to: ') && sec.moveTo === null && sec.chunks.length === 0 && chunk === null) {
          sec.moveTo = l.slice('*** Move to: '.length).trim();
          started = true;
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          finish(false);
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          started = true;
          i++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (!chunk) throw new ParseErr(first + 2 + i);
          chunk.eof = true;
          finish(false);
          started = true;
          i++;
          continue;
        }
        if (isBlank(l)) {
          if (chunk) {
            chunk.items.push({ mark: ' ', text: '' });
            i++;
            continue;
          }
          if (!started) {
            chunk = { anchor: null, eof: false, items: [{ mark: ' ', text: '' }] };
            started = true;
            i++;
            continue;
          }
          // A blank line between chunks is ignored.
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
          if (!chunk) {
            if (sec.chunks.length === 0) {
              // The first chunk may start at a body line.
              chunk = { anchor: null, eof: false, items: [] };
              started = true;
            } else {
              // Later chunks start at an @@ line only.
              throw new ParseErr(first + 2 + i);
            }
          }
          chunk.items.push({ mark: l[0], text: l.slice(1) });
          i++;
          continue;
        }
        throw new ParseErr(first + 2 + i);
      }
      finish(true);
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new ParseErr(updateLine);
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new ParseErr(1);

  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      const path = s.path;
      const fileLines = s.fileLines;
      edits.push((tree: Tree) => {
        if (!safePath(path)) throw new EditFail('unsafe', path);
        if (tree.get(path) !== null) throw new EditFail('exists', path);
        const doc: Doc = { lines: [...fileLines], br: '\n', final: fileLines.length > 0 };
        tree.put(path, writeDoc(doc));
      });
    } else if (s.kind === 'delete') {
      const path = s.path;
      edits.push((tree: Tree) => {
        if (!safePath(path)) throw new EditFail('unsafe', path);
        if (tree.get(path) === null) throw new EditFail('missing', path);
        tree.put(path, null);
      });
    } else {
      const from = s.path;
      const to = s.moveTo;
      const chunks = s.chunks;
      const copied: VChunk[] = chunks.map((c) => ({ anchor: c.anchor, eof: c.eof, items: c.items }));
      edits.push((tree: Tree, mv: Move[]) => {
        if (!safePath(from)) throw new EditFail('unsafe', from);
        if (to !== null && !safePath(to)) throw new EditFail('unsafe', to);
        const before = tree.get(from);
        if (before === null) throw new EditFail('missing', from);
        if (to !== null && to !== from && tree.get(to) !== null) throw new EditFail('exists', to);
        const doc = readDoc(before);
        let cursor = 0;
        for (const ch of copied) {
          if (ch.anchor !== null && ch.anchor !== '') {
            let foundAt = -1;
            const top = strict ? 1 : 3;
            for (let tier = 0; tier < top; tier++) {
              const target = tiered(ch.anchor, tier);
              for (let k = cursor; k < doc.lines.length; k++) {
                if (tiered(doc.lines[k], tier) === target) {
                  foundAt = k;
                  break;
                }
              }
              if (foundAt >= 0) break;
            }
            if (foundAt < 0) throw new EditFail('no-match', from);
            cursor = foundAt + 1;
          }
          const { old, newLines } = hunkOldNew(ch.items);
          if (old.length === 0) {
            const ins = ch.eof ? doc.lines.length : cursor;
            const add = newLines.map((n) => n.text);
            doc.lines.splice(ins, 0, ...add);
            cursor = ins + add.length;
          } else {
            let found: { tier: number; at: number[] } | null = null;
            const top = strict ? 1 : 3;
            for (let tier = 0; tier < top; tier++) {
              const at = occurrences(doc.lines, old, tier).filter((p) => p >= cursor && (!ch.eof || p + old.length === doc.lines.length));
              if (at.length > 0) {
                found = { tier, at };
                break;
              }
            }
            if (!found) throw new EditFail('no-match', from);
            const pos = found.at[0];
            const replacement = renderNew(newLines, old, doc.lines, pos, found.tier);
            doc.lines.splice(pos, old.length, ...replacement);
            cursor = pos + replacement.length;
          }
        }
        const text = writeDoc(doc);
        if (to !== null && to !== from) {
          tree.put(from, null);
          tree.put(to, text);
          mv.push({ old: from, next: to });
        } else {
          tree.put(from, text);
        }
      });
    }
  }
  return edits;
}

// --------------------------------------------------------------------- run

function parseEdits(kind: Format, text: string, lines: string[], strict: boolean, moves: Move[]): Edit[] {
  if (kind === 'unified') return parseUnified(lines, strict, moves);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict, moves);
  if (kind === 'v4a') return parseV4a(lines, strict, moves);
  return parseJsonEdits(text, lines);
}

interface RunResult {
  code: number;
  out: string[];
}

function run(argv: string[]): RunResult {
  const formats = ['auto', 'unified', 'search-replace', 'v4a', 'json'];
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && formats.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : (format as Format);
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    edits = parseEdits(kind, text, lines, strict, moves);
    if (edits.length === 0) throw new ParseErr(1);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.at}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.now);
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of snap) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    const out: string[] = fails.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${fails.length} of ${edits.length} edits`);
    return { code: 1, out };
  }
  // What changed, in byte order, with moves folded into one R line.
  const changed = new Map<string, string | null>();
  for (const [p, v] of tree.now) {
    if (tree.original(p) !== v) changed.set(p, v);
  }
  const rows: { key: string; line: string }[] = [];
  const hidden = new Set<string>();
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.next);
    const nowNew = tree.get(m.next);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      hidden.add(m.old);
      hidden.add(m.next);
      rows.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
    }
  }
  for (const [p, v] of changed) {
    if (hidden.has(p)) continue;
    if (v === null) rows.push({ key: p, line: `D ${p}` });
    else if (tree.original(p) === null) rows.push({ key: p, line: `A ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  rows.sort((a, b) => byteLess(a.key, b.key));
  const out = rows.map((r) => r.line);
  const n = out.length;
  out.push(`ok: ${n} file${n === 1 ? '' : 's'}`);
  if (!check) {
    for (const [p, v] of changed) {
      if (v === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  return { code: 0, out };
}

// ------------------------------------------------------------------ entry

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = run(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
