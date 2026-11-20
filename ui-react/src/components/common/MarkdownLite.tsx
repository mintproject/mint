import { Fragment, type ReactNode } from 'react';

/**
 * A small, safe Markdown renderer for result reports: headings, paragraphs,
 * lists, quotes, fenced code, pipe tables, rules, and the inline `code`,
 * **bold**, *italic* and [links](https://…). It builds React elements, never
 * HTML, and links only open http(s) addresses. It is not a full CommonMark
 * implementation: anything it does not know shows as plain text.
 */

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = match[0];
    const key = `${keyBase}-${index++}`;
    if (token.startsWith('`')) {
      out.push(
        <code key={key} className="rounded bg-gray-100 px-1 py-0.5 text-[0.9em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = link?.[1] ?? token;
      const href = link?.[2] ?? '';
      out.push(
        /^https?:\/\//i.test(href) ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            {label}
          </a>
        ) : (
          label
        ),
      );
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

const HEADING_CLASS = [
  '',
  'text-lg font-semibold',
  'text-base font-semibold',
  'text-sm font-semibold',
  'text-sm font-medium',
  'text-sm font-medium',
  'text-sm font-medium',
];

export function MarkdownLite({ source, testId }: { source: string; testId?: string }) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  const startsBlock = (line: string) =>
    HEADING.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    RULE.test(line) ||
    TABLE_ROW.test(line) ||
    line.startsWith('```') ||
    line.startsWith('>');

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const key = `b${blocks.length}`;
    if (line.trim() === '') {
      i += 1;
    } else if (line.startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={key} className="overflow-x-auto rounded bg-gray-100 p-2 text-xs">
          {code.join('\n')}
        </pre>,
      );
    } else if (HEADING.test(line)) {
      const [, hashes = '#', text = ''] = HEADING.exec(line) ?? [];
      const level = Math.min(hashes.length, 6);
      const Tag = `h${Math.min(level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(
        <Tag key={key} className={HEADING_CLASS[level]}>
          {inline(text, key)}
        </Tag>,
      );
      i += 1;
    } else if (RULE.test(line)) {
      blocks.push(<hr key={key} className="border-gray-200" />);
      i += 1;
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const match = (ordered ? NUMBERED : BULLET).exec(lines[i] ?? '');
        if (!match) break;
        items.push(match[1] ?? '');
        i += 1;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={key} className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 pl-5`}>
          {items.map((item, n) => (
            <li key={n}>{inline(item, `${key}-${n}`)}</li>
          ))}
        </List>,
      );
    } else if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        quote.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push(
        <blockquote key={key} className="border-l-2 border-gray-300 pl-3 text-gray-600">
          {inline(quote.join(' '), key)}
        </blockquote>,
      );
    } else if (TABLE_ROW.test(line)) {
      const rows: string[][] = [];
      let header = false;
      while (i < lines.length && TABLE_ROW.test(lines[i] ?? '')) {
        const current = lines[i] ?? '';
        if (TABLE_DIVIDER.test(current)) header = rows.length === 1;
        else rows.push(cells(current));
        i += 1;
      }
      const [head, ...body] = header ? rows : [undefined, ...rows];
      blocks.push(
        <div key={key} className="overflow-x-auto">
          <table className="border-collapse text-xs">
            {head && (
              <thead className="bg-gray-100">
                <tr>
                  {head.map((cell, n) => (
                    <th key={n} className="border border-gray-200 px-2 py-1 text-left">
                      {inline(cell, `${key}-h${n}`)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((row = [], r) => (
                <tr key={r}>
                  {row.map((cell, n) => (
                    <td key={n} className="border border-gray-200 px-2 py-1">
                      {inline(cell, `${key}-${r}-${n}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else {
      const paragraph: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim() !== '' && !startsBlock(lines[i] ?? '')) {
        paragraph.push(lines[i] ?? '');
        i += 1;
      }
      if (paragraph.length === 0) {
        paragraph.push(line);
        i += 1;
      }
      blocks.push(
        <p key={key}>
          {paragraph.map((text, n) => (
            <Fragment key={n}>
              {n > 0 && ' '}
              {inline(text, `${key}-${n}`)}
            </Fragment>
          ))}
        </p>,
      );
    }
  }

  return (
    <div className="space-y-2 text-sm text-gray-800" data-testid={testId}>
      {blocks}
    </div>
  );
}
