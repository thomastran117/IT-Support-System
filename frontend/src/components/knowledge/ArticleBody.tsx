import { Fragment } from 'react';
import { parseMarkdown, type Inline } from '@/lib/knowledge/markdown';

function Inlines({ content }: { content: Inline[] }) {
  return (
    <>
      {content.map((part, i) =>
        part.kind === 'code' ? (
          <code key={i} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.9em]">
            {part.text}
          </code>
        ) : part.kind === 'strong' ? (
          <strong key={i}>{part.text}</strong>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

/** Renders article text. Everything is a React text node, so markup in an article stays inert. */
export function ArticleBody({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div data-testid="article-body" className="space-y-4 leading-7 text-slate-800">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = `h${block.level}` as 'h2' | 'h3' | 'h4';
            return (
              <Tag key={i} className="pt-2 text-lg font-bold text-slate-950">
                <Inlines content={block.content} />
              </Tag>
            );
          }
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag
                key={i}
                className={`space-y-1.5 pl-6 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
              >
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inlines content={item} />
                  </li>
                ))}
              </Tag>
            );
          }
          case 'code':
            return (
              <pre
                key={i}
                tabIndex={0}
                aria-label="Code sample"
                className="overflow-x-auto rounded-xl bg-slate-900 p-4 font-mono text-sm text-slate-100"
              >
                {block.text}
              </pre>
            );
          default:
            return (
              <p key={i}>
                <Inlines content={block.content} />
              </p>
            );
        }
      })}
    </div>
  );
}
