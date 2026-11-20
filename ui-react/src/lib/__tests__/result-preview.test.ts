import { describe, expect, it } from 'vitest';

import {
  PREVIEW_CSV_CELL_CHARS,
  PREVIEW_CSV_COLUMNS,
  decodePreviewText,
  parseCsvRows,
  prettyJson,
  previewKind,
} from '../result-preview';

describe('previewKind', () => {
  it('reads the kind from the file name', () => {
    expect(previewKind('report.md')).toBe('markdown');
    expect(previewKind('REPORT.MARKDOWN')).toBe('markdown');
    expect(previewKind('table.csv')).toBe('csv');
    expect(previewKind('lexicon.json')).toBe('json');
    expect(previewKind('map.tif')).toBeNull();
    expect(previewKind('noextension')).toBeNull();
  });
});

describe('decodePreviewText', () => {
  it('decodes UTF-8 and survives a cut multi-byte character', () => {
    expect(decodePreviewText(new TextEncoder().encode('héllo'))).toBe('héllo');
    const cut = new TextEncoder().encode('é').slice(0, 1);
    expect(() => decodePreviewText(cut)).not.toThrow();
  });
});

describe('parseCsvRows', () => {
  it('reads quoted fields, doubled quotes and a newline inside quotes', () => {
    const { rows, truncated } = parseCsvRows('a,b\n"x, y","say ""hi"""\n"two\nlines",z\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', 'z'],
    ]);
    expect(truncated).toBe(false);
  });

  it('stops after the row limit, says more followed, and handles CRLF', () => {
    const text = Array.from({ length: 30 }, (_, i) => `r${i},v${i}`).join('\r\n');
    const { rows, truncated } = parseCsvRows(text, 10);
    expect(rows).toHaveLength(10);
    expect(rows[9]).toEqual(['r9', 'v9']);
    expect(truncated).toBe(true);
  });

  it('is not truncated when it ends exactly at the limit, or has no final newline', () => {
    expect(parseCsvRows('a,b\n1,2', 10)).toEqual({
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
      truncated: false,
    });
    expect(parseCsvRows('a\n1\n', 2).truncated).toBe(false);
  });

  it('caps the columns of a row and the characters of a cell, and says so', () => {
    const wide = Array.from({ length: PREVIEW_CSV_COLUMNS + 30 }, (_, i) => `c${i}`).join(',');
    const parsed = parseCsvRows(wide);
    expect(parsed.rows[0]).toHaveLength(PREVIEW_CSV_COLUMNS);
    expect(parsed.truncated).toBe(true);

    const long = parseCsvRows(`${'x'.repeat(100_000)},b`);
    expect(long.rows[0]?.[0]).toHaveLength(PREVIEW_CSV_CELL_CHARS);
    expect(long.rows[0]?.[1]).toBe('b');
    expect(long.truncated).toBe(true);
  });

  it('is fast on a very large single-line file', () => {
    const started = Date.now();
    parseCsvRows(','.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('prettyJson', () => {
  it('indents valid JSON', () => {
    expect(prettyJson('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}' });
  });

  it('shows cut-off JSON as it is and says it was cut off, not that it is malformed', () => {
    const cut = prettyJson('{"a":', { truncated: true });
    expect(cut.text).toBe('{"a":');
    expect(cut.note).toMatch(/only the start/i);
    expect(cut.note).not.toMatch(/not valid/i);
  });

  it('says so for JSON that does not parse', () => {
    expect(prettyJson('{"a":').note).toMatch(/not valid JSON/);
  });

  it('does not indent a file that is too large', () => {
    const big = JSON.stringify({ a: 'x'.repeat(200_000) });
    const out = prettyJson(big);
    expect(out.text).toBe(big);
    expect(out.note).toMatch(/too large/);
  });

  it('does not indent, and does not blow the stack on, deeply nested JSON', () => {
    const deep = '['.repeat(50_000) + ']'.repeat(50_000);
    const started = Date.now();
    const out = prettyJson(deep);
    expect(out.text).toBe(deep);
    expect(out.note).toMatch(/nested too deeply/);
    expect(Date.now() - started).toBeLessThan(1000);
    const ok = '['.repeat(10) + ']'.repeat(10);
    expect(prettyJson(ok).note).toBeUndefined();
  });
});

describe('outputPreviewKind', () => {
  it('reads the kind from the location first, as a result is named by its label', async () => {
    const { outputPreviewKind } = await import('@/lib/result-preview');
    expect(outputPreviewKind('tapis://s/out/summary.md', 'Sensemaking report')).toBe('markdown');
    expect(outputPreviewKind('tapis://s/out/x', 'weights.csv')).toBe('csv');
    expect(outputPreviewKind('tapis://s/out/x', 'Lexicon', 'json')).toBe('json');
    expect(outputPreviewKind('tapis://s/out/x', 'Report', 'Markdown')).toBe('markdown');
    expect(outputPreviewKind('tapis://s/out/model.tif', 'Raster', 'GeoTIFF')).toBeNull();
  });
});
