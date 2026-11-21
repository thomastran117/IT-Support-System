import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/lib/auth/client';
import { knowledgeApi } from '../../src/lib/knowledge/api';
import { parseInline, parseMarkdown } from '../../src/lib/knowledge/markdown';

describe('parseInline', () => {
  it('splits code and bold from text and keeps everything else verbatim', () => {
    expect(parseInline('Run `ipconfig /all` and **reboot** now')).toEqual([
      { kind: 'text', text: 'Run ' },
      { kind: 'code', text: 'ipconfig /all' },
      { kind: 'text', text: ' and ' },
      { kind: 'strong', text: 'reboot' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('leaves unmatched markers, empty markers and markup as plain text', () => {
    expect(parseInline('a ** b ` c')).toEqual([{ kind: 'text', text: 'a ** b ` c' }]);
    expect(parseInline('<b>x</b>')).toEqual([{ kind: 'text', text: '<b>x</b>' }]);
    expect(parseInline('')).toEqual([]);
  });
});

describe('parseMarkdown', () => {
  it('builds headings below the page title, lists, code and paragraphs', () => {
    const blocks = parseMarkdown(
      [
        '# Fix it',
        'First line',
        'second line',
        '',
        '- one',
        '* two',
        '',
        '1. step',
        '2) step two',
        '',
        '```',
        'a <b> c',
        '```',
        '### Deep',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'code',
      'heading',
    ]);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2 });
    expect(blocks[5]).toMatchObject({ kind: 'heading', level: 4 });
    expect(blocks[1]).toMatchObject({
      content: [{ kind: 'text', text: 'First line second line' }],
    });
    expect(blocks[2]).toMatchObject({ ordered: false });
    expect((blocks[2] as { items: unknown[] }).items).toHaveLength(2);
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect(blocks[4]).toEqual({ kind: 'code', text: 'a <b> c' });
  });

  it('never produces anything but text for hostile input', () => {
    const blocks = parseMarkdown(
      '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n<img src=x onerror=1>',
    );
    const texts = blocks.flatMap((b) =>
      b.kind === 'paragraph' ? b.content.map((i) => i.text) : [],
    );
    expect(texts.join('|')).toBe(
      '<script>alert(1)</script>|[x](javascript:alert(1))|<img src=x onerror=1>',
    );
    // The only node kinds a renderer can see are the known, escaped ones.
    expect(new Set(blocks.map((b) => b.kind))).toEqual(new Set(['paragraph']));
  });

  it('handles empty input, CRLF and an unterminated fence without throwing', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('a\r\n\r\nb')).toHaveLength(2);
    expect(parseMarkdown('```\nnever closed')).toEqual([{ kind: 'code', text: 'never closed' }]);
  });
});

describe('knowledgeApi', () => {
  const make = () => {
    const request = vi.fn().mockResolvedValue({});
    return { request, kb: knowledgeApi({ request } as unknown as ApiClient) };
  };

  it('encodes the query and omits empty parameters', async () => {
    const { kb, request } = make();
    await kb.search({ q: "vpn & 'x' ?", categoryId: '', limit: 10, offset: 0 });
    expect(request).toHaveBeenCalledWith(
      '/api/knowledge/search?q=vpn+%26+%27x%27+%3F&limit=10&offset=0',
    );
    await kb.list();
    expect(request).toHaveBeenLastCalledWith('/api/knowledge');
    await kb.list({ categoryId: 'c1', offset: 20 });
    expect(request).toHaveBeenLastCalledWith('/api/knowledge?categoryId=c1&offset=20');
  });

  it('encodes ids and uses the admin routes only for writes', async () => {
    const { kb, request } = make();
    await kb.get('a/b');
    expect(request).toHaveBeenLastCalledWith('/api/knowledge/a%2Fb');
    await kb.publish('x');
    expect(request).toHaveBeenLastCalledWith('/api/admin/knowledge/x/publish', { method: 'POST' });
    await kb.update('x', { title: 't', body: 'b', categoryId: null });
    expect(request).toHaveBeenLastCalledWith('/api/admin/knowledge/x', {
      method: 'PATCH',
      body: JSON.stringify({ title: 't', body: 'b', categoryId: null }),
    });
    await kb.adminList({ published: false });
    expect(request).toHaveBeenLastCalledWith('/api/admin/knowledge?published=false');
  });
});
