/**
 * A deliberately tiny Markdown subset, parsed into plain data. The renderer turns these nodes into
 * React elements, so every character reaches the DOM as an escaped text node: there is no
 * `dangerouslySetInnerHTML`, no HTML pass-through and no links (a URL stays visible text, which
 * rules out `javascript:` and similar schemes).
 *
 * Supported: `#`/`##`/`###` headings, `-`/`*` bullets, `1.` numbered items, fenced code, paragraphs,
 * and inline `code` and `**bold**`.
 */
export type Inline = { kind: 'text' | 'code' | 'strong'; text: string };

export type Block =
  | { kind: 'heading'; level: 2 | 3 | 4; content: Inline[] }
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string };

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      out.push({ kind: 'code', text: part.slice(1, -1) });
    } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      out.push({ kind: 'strong', text: part.slice(2, -2) });
    } else {
      out.push({ kind: 'text', text: part });
    }
  }
  return out;
}

const HEADING = /^(#{1,3})\s+(.+)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) blocks.push({ kind: 'list', ...list });
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('```')) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) code.push(lines[i++]!);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        kind: 'heading',
        level: (heading[1]!.length + 1) as 2 | 3 | 4,
        content: parseInline(heading[2]!.trim()),
      });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flushParagraph();
      const ordered = numbered !== null;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(parseInline(item[1]!.trim()));
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}
