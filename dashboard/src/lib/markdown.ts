/**
 * A small Markdown reader for the read-only note view. It turns text into a plain data tree that
 * `components/Markdown.svelte` renders with ordinary Svelte elements: no HTML string is ever built or injected, so
 * whatever a note contains (raw HTML, scripts, event handlers) shows up as literal text.
 *
 * Covered: ATX and setext headings, paragraphs, fenced and indented code, block quotes, ordered/unordered/task lists
 * (nested by indentation), GFM tables, thematic breaks; inline code, strong, emphasis, strikethrough, links, autolinks
 * and images (shown as links: the dashboard never loads remote images). Not CommonMark-complete by design.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  | { t: 'br' }
  /** `href` is null when the target is not a safe absolute URL (it is then shown as plain text). */
  | { t: 'link'; href: string | null; title: string; c: Inline[] }
  | { t: 'image'; href: string | null; alt: string };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: 'paragraph'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

export interface ListItem {
  /** null: not a task; true/false: `- [x]` / `- [ ]`. */
  checked: boolean | null;
  c: Block[];
}

/** Only absolute http(s) and mailto links are clickable. */
export function safeHref(raw: string): string | null {
  const v = raw.trim();
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return u.href;
  } catch {
    /* relative or malformed: not clickable */
  }
  return null;
}

const MAX_DEPTH = 12;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return parseBlocks(lines, 0);
}

const reFence = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const reHeading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const reHr = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const reQuote = /^ {0,3}> ?/;
const reBullet = /^( {0,3})([-*+])( +)(.*)$/;
const reOrdered = /^( {0,3})(\d{1,9})([.)])( +)(.*)$/;
const reSetext = /^ {0,3}(=+|-+)[ \t]*$/;
const reTableSep = /^ {0,3}\|?(\s*:?-{1,}:?\s*\|)*\s*:?-{1,}:?\s*\|?\s*$/;
const isBlank = (l: string) => l.trim() === '';

function listMarker(line: string) {
  const b = reBullet.exec(line);
  if (b) return { ordered: false, start: 1, width: b[1]!.length + 1 + Math.min(b[3]!.length, 4), rest: b[4]! };
  const o = reOrdered.exec(line);
  if (o) return { ordered: true, start: Number(o[2]), width: o[1]!.length + o[2]!.length + 1 + Math.min(o[4]!.length, 4), rest: o[5]! };
  // An empty item ("-" alone).
  const e = /^( {0,3})([-*+]|\d{1,9}[.)])$/.exec(line);
  if (e) return { ordered: /\d/.test(e[2]!), start: parseInt(e[2]!, 10) || 1, width: e[1]!.length + e[2]!.length + 1, rest: '' };
  return null;
}

function startsBlock(line: string): boolean {
  return reFence.test(line) || reHeading.test(line) || reHr.test(line) || reQuote.test(line) || listMarker(line) !== null;
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  if (depth > MAX_DEPTH) {
    const text = lines.join('\n').trim();
    return text ? [{ t: 'paragraph', c: [{ t: 'text', v: text }] }] : [];
  }
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    // Fenced code.
    const fence = reFence.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // closing fence (or end of input)
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }

    // Indented code.
    if (/^ {4}/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]!) || isBlank(lines[i]!))) {
        body.push(lines[i]!.slice(4));
        i++;
      }
      while (body.length && isBlank(body[body.length - 1]!)) body.pop();
      out.push({ t: 'code', lang: '', v: body.join('\n') });
      continue;
    }

    const h = reHeading.exec(line);
    if (h) {
      out.push({ t: 'heading', level: h[1]!.length as 1, c: parseInline(h[2] ?? '') });
      i++;
      continue;
    }

    if (reHr.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }

    if (reQuote.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i]!)) {
        const l = lines[i]!;
        if (reQuote.test(l)) body.push(l.replace(reQuote, ''));
        else if (body.length && !startsBlock(l)) body.push(l); // lazy continuation
        else break;
        i++;
      }
      out.push({ t: 'quote', c: parseBlocks(body, depth + 1) });
      continue;
    }

    const first = listMarker(line);
    if (first) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = listMarker(lines[i]!);
        if (!m || m.ordered !== first.ordered) break;
        const body: string[] = [m.rest];
        i++;
        while (i < lines.length) {
          const l = lines[i]!;
          if (isBlank(l)) {
            // A blank line continues the item only if the next line is indented into it.
            const next = lines[i + 1];
            if (next !== undefined && next.startsWith(' '.repeat(m.width))) {
              body.push('');
              i++;
              continue;
            }
            break;
          }
          if (l.startsWith(' '.repeat(m.width))) body.push(l.slice(m.width));
          else if (listMarker(l) || startsBlock(l)) break;
          else body.push(l.trimStart()); // lazy continuation of the paragraph
          i++;
        }
        let checked: boolean | null = null;
        const task = /^\[([ xX])\](?: +|$)/.exec(body[0] ?? '');
        if (task) {
          checked = task[1] !== ' ';
          body[0] = body[0]!.slice(task[0].length);
        }
        items.push({ checked, c: parseBlocks(body, depth + 1) });
        // Blank lines between items keep the list going.
        let j = i;
        while (j < lines.length && isBlank(lines[j]!)) j++;
        if (j < lines.length && j > i) {
          const nm = listMarker(lines[j]!);
          if (nm && nm.ordered === first.ordered) i = j;
        }
      }
      out.push({ t: 'list', ordered: first.ordered, start: first.start, items });
      continue;
    }

    // GFM table: a header row followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && reTableSep.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map<Align>((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes('|')) {
        const cells = splitRow(lines[i]!);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? '')));
        i++;
      }
      out.push({ t: 'table', align: head.map((_, k) => align[k] ?? null), head: head.map(parseInline), rows });
      continue;
    }

    // Paragraph (possibly a setext heading).
    const para: string[] = [line];
    i++;
    let setext: 1 | 2 | 0 = 0;
    while (i < lines.length && !isBlank(lines[i]!)) {
      const l = lines[i]!;
      const st = reSetext.exec(l);
      if (st) {
        setext = st[1]![0] === '=' ? 1 : 2;
        i++;
        break;
      }
      if (startsBlock(l)) break;
      para.push(l);
      i++;
    }
    const text = para.map((l) => l.trim()).join('\n');
    out.push(setext ? { t: 'heading', level: setext, c: parseInline(text) } : { t: 'paragraph', c: parseInline(text) });
  }
  return out;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]!;
    if (ch === '\\' && s[k + 1] === '|') {
      cur += '|';
      k++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const ESCAPABLE = '\\`*_{}[]()#+-.!|~<>';

/** Inline markup. `depth` bounds recursion for pathological input. */
export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  if (depth > MAX_DEPTH) return src ? [{ t: 'text', v: src }] : [];

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    // Hard break: backslash or two spaces before a newline.
    if (ch === '\n') {
      if (/( {2,}|\\)$/.test(text)) {
        text = text.replace(/( {2,}|\\)$/, '');
        flush();
        out.push({ t: 'br' });
      } else text += ' ';
      i++;
      continue;
    }

    if (ch === '`') {
      const run = /^`+/.exec(src.slice(i))![0];
      const end = src.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        let code = src.slice(i + run.length, end).replace(/\n/g, ' ');
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        out.push({ t: 'code', v: code });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }

    // Autolink <https://...>
    if (ch === '<') {
      const m = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: 'link', href: safeHref(m[1]!), title: m[1]!, c: [{ t: 'text', v: m[1]! }] });
        i += m[0].length;
        continue;
      }
    }

    // Image ![alt](src) and link [text](href)
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const isImage = ch === '!';
      const open = isImage ? i + 1 : i;
      const close = matchBracket(src, open);
      if (close > 0 && src[close + 1] === '(') {
        const target = matchParen(src, close + 1);
        if (target > 0) {
          const label = src.slice(open + 1, close);
          const dest = src.slice(close + 2, target).trim();
          const url = /^<([^>]*)>/.exec(dest)?.[1] ?? dest.split(/\s+/)[0] ?? '';
          flush();
          if (isImage) out.push({ t: 'image', href: safeHref(url), alt: label });
          else out.push({ t: 'link', href: safeHref(url), title: url, c: parseInline(label, depth + 1) });
          i = target + 1;
          continue;
        }
      }
    }

    // Bare URLs.
    if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(src.slice(i, i + 8)) && (i === 0 || /[\s(]/.test(src[i - 1]!))) {
      const m = /^https?:\/\/[^\s<>]+/i.exec(src.slice(i))!;
      const url = m[0].replace(/[.,;:!?)\]]+$/, '');
      flush();
      out.push({ t: 'link', href: safeHref(url), title: url, c: [{ t: 'text', v: url }] });
      i += url.length;
      continue;
    }

    // ~~strike~~, **strong** / __strong__, *em* / _em_
    if (ch === '~' && src[i + 1] === '~') {
      const end = src.indexOf('~~', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'del', c: parseInline(src.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] === ch && canOpen(src, i, 2)) {
      const end = findCloser(src, ch + ch, i + 2);
      if (end > 0) {
        flush();
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] !== ch && canOpen(src, i, 1)) {
      const end = findCloser(src, ch, i + 1);
      if (end > 0) {
        flush();
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
/** Start and end of the text count as whitespace (CommonMark flanking rules). */
const isWs = (c: string | undefined) => c === undefined || /\s/u.test(c);
const isPunct = (c: string | undefined) => !!c && /[\p{P}\p{S}]/u.test(c);

/** A left-flanking delimiter run of `len` chars at `i` (and for `_`, not inside a word). */
function canOpen(src: string, i: number, len: number): boolean {
  const prev = src[i - 1];
  const next = src[i + len];
  const left = !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
  return left && (src[i] !== '_' || !isWordChar(prev));
}

/** A right-flanking delimiter run of `len` chars at `k` (and for `_`, not inside a word). */
function canClose(src: string, k: number, len: number): boolean {
  const prev = src[k - 1];
  const next = src[k + len];
  const right = !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
  return right && (src[k] !== '_' || !isWordChar(next));
}

/** The closing delimiter (right-flanking, not escaped, not inside a code span). */
function findCloser(src: string, delim: string, from: number): number {
  let k = from;
  while (k < src.length) {
    const ch = src[k]!;
    if (ch === '\\') {
      k += 2;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(src.slice(k))![0];
      const end = src.indexOf(run, k + run.length);
      k = end > 0 ? end + run.length : k + run.length;
      continue;
    }
    if (delim.length === 1 && src.startsWith(delim + delim, k)) {
      // Skip a nested strong run inside emphasis.
      const inner = canOpen(src, k, 2) ? findCloser(src, delim + delim, k + 2) : -1;
      k = inner > 0 ? inner + 2 : k + 2;
      continue;
    }
    if (src.startsWith(delim, k) && k > from && canClose(src, k, delim.length)) return k;
    k++;
  }
  return -1;
}

function matchBracket(src: string, open: number): number {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const ch = src[k];
    if (ch === '\\') k++;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const ch = src[k];
    if (ch === '\\') k++;
    else if (ch === '\n') return -1;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}
