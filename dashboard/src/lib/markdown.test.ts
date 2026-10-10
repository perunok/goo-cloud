import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeHref } from './markdown';

describe('parseMarkdown blocks', () => {
  it('headings, paragraphs, rules and setext headings', () => {
    expect(parseMarkdown('# Title\n\nSome *text*\nwraps.\n\n---\n\nSub\n===')).toEqual([
      { t: 'heading', level: 1, c: [{ t: 'text', v: 'Title' }] },
      { t: 'paragraph', c: [{ t: 'text', v: 'Some ' }, { t: 'em', c: [{ t: 'text', v: 'text' }] }, { t: 'text', v: ' wraps.' }] },
      { t: 'hr' },
      { t: 'heading', level: 1, c: [{ t: 'text', v: 'Sub' }] },
    ]);
  });

  it('fenced and indented code keep their text verbatim', () => {
    const blocks = parseMarkdown('```js\nconst a = "<b>";\n\n**not bold**\n```\n\n    indented <i>');
    expect(blocks).toEqual([
      { t: 'code', lang: 'js', v: 'const a = "<b>";\n\n**not bold**' },
      { t: 'code', lang: '', v: 'indented <i>' },
    ]);
  });

  it('lists: bullets, ordered with start, tasks and nesting', () => {
    const [ul, ol] = parseMarkdown('- [x] done\n- [ ] todo\n  - nested\n\n3. three\n4. four');
    expect(ul).toMatchObject({ t: 'list', ordered: false, items: [{ checked: true }, { checked: false }] });
    const second = (ul as { items: { c: unknown[] }[] }).items[1]!;
    expect(second.c[1]).toMatchObject({ t: 'list', items: [{ checked: null, c: [{ t: 'paragraph', c: [{ t: 'text', v: 'nested' }] }] }] });
    expect(ol).toMatchObject({ t: 'list', ordered: true, start: 3 });
    expect((ol as { items: unknown[] }).items).toHaveLength(2);
  });

  it('block quotes and tables', () => {
    const [quote, table] = parseMarkdown('> quoted **bold**\n> more\n\n| a | b |\n|:--|--:|\n| 1 | 2 \\| 3 |');
    expect(quote).toMatchObject({ t: 'quote', c: [{ t: 'paragraph' }] });
    expect(table).toEqual({
      t: 'table',
      align: ['left', 'right'],
      head: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]],
      rows: [[[{ t: 'text', v: '1' }], [{ t: 'text', v: '2 | 3' }]]],
    });
  });

  it('raw HTML is just text', () => {
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([{ t: 'paragraph', c: [{ t: 'text', v: '<script>alert(1)</script>' }] }]);
  });

  it('survives deep nesting without blowing the stack', () => {
    expect(() => parseMarkdown('>'.repeat(5000) + ' deep')).not.toThrow();
    expect(() => parseInline('['.repeat(3000) + 'x' + ']'.repeat(3000))).not.toThrow();
    expect(() => parseInline('*a '.repeat(2000))).not.toThrow();
  });
});

describe('parseInline', () => {
  it('code, strong, emphasis, strikethrough, escapes', () => {
    expect(parseInline('`a*b*` **s** _e_ ~~d~~ \\*lit\\*')).toEqual([
      { t: 'code', v: 'a*b*' },
      { t: 'text', v: ' ' },
      { t: 'strong', c: [{ t: 'text', v: 's' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'e' }] },
      { t: 'text', v: ' ' },
      { t: 'del', c: [{ t: 'text', v: 'd' }] },
      { t: 'text', v: ' *lit*' },
    ]);
  });

  it('snake_case words are not emphasis', () => {
    expect(parseInline('a snake_case_name here')).toEqual([{ t: 'text', v: 'a snake_case_name here' }]);
  });

  it('links: only http(s) and mailto are clickable', () => {
    expect(parseInline('[ok](https://example.com/a?b=1)')).toEqual([
      { t: 'link', href: 'https://example.com/a?b=1', title: 'https://example.com/a?b=1', c: [{ t: 'text', v: 'ok' }] },
    ]);
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'other.md', '/etc/passwd']) {
      expect(parseInline(`[x](${bad})`)[0]).toMatchObject({ t: 'link', href: null });
    }
    expect(parseInline('<mailto:a@b.co>')[0]).toMatchObject({ t: 'link', href: 'mailto:a@b.co' });
    expect(parseInline('see https://example.com/x.')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://example.com/x', title: 'https://example.com/x', c: [{ t: 'text', v: 'https://example.com/x' }] },
      { t: 'text', v: '.' },
    ]);
  });

  it('images become links and are never loaded', () => {
    expect(parseInline('![logo](https://example.com/l.png)')).toEqual([{ t: 'image', href: 'https://example.com/l.png', alt: 'logo' }]);
    expect(parseInline('![x](javascript:alert(1))')).toEqual([{ t: 'image', href: null, alt: 'x' }]);
  });

  it('hard line breaks', () => {
    expect(parseInline('a  \nb')).toEqual([{ t: 'text', v: 'a' }, { t: 'br' }, { t: 'text', v: 'b' }]);
  });
});

describe('safeHref', () => {
  it('normalises allowed URLs and rejects the rest', () => {
    expect(safeHref(' https://example.com ')).toBe('https://example.com/');
    expect(safeHref('java\nscript:alert(1)')).toBeNull();
    expect(safeHref('')).toBeNull();
  });
});

describe('emphasis flanking rules', () => {
  it('identifiers with double underscores are not strong', () => {
    const src = 'window.__pwned = 1 and later window.__pwned';
    expect(parseInline(src)).toEqual([{ t: 'text', v: src }]);
  });
  it('a lone asterisk between spaces is text; nested strong in emphasis works', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ t: 'text', v: '2 * 3 * 4' }]);
    expect(parseInline('*a **b** c*')).toEqual([
      { t: 'em', c: [{ t: 'text', v: 'a ' }, { t: 'strong', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' c' }] },
    ]);
    expect(parseInline('__init__ and **"quoted"**')).toEqual([
      { t: 'strong', c: [{ t: 'text', v: 'init' }] },
      { t: 'text', v: ' and ' },
      { t: 'strong', c: [{ t: 'text', v: '"quoted"' }] },
    ]);
  });
});
