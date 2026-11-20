import { describe, expect, it } from 'vitest';

import { parseCsvRows, prettyJson, previewKind, readBlobText } from '../result-preview';

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

describe('parseCsvRows', () => {
  it('reads quoted fields, doubled quotes and a newline inside quotes', () => {
    const rows = parseCsvRows('a,b\n"x, y","say ""hi"""\n"two\nlines",z\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', 'z'],
    ]);
  });

  it('stops after the row limit and handles CRLF and a missing final newline', () => {
    const text = Array.from({ length: 30 }, (_, i) => `r${i},v${i}`).join('\r\n');
    const rows = parseCsvRows(text, 10);
    expect(rows).toHaveLength(10);
    expect(rows[9]).toEqual(['r9', 'v9']);
    expect(parseCsvRows('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('prettyJson', () => {
  it('indents valid JSON and leaves cut-off JSON as it was', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('{"a":')).toBe('{"a":');
  });
});

describe('readBlobText', () => {
  it('reads a small blob whole', async () => {
    expect(await readBlobText(new Blob(['hello']))).toEqual({ text: 'hello', truncated: false });
  });

  it('reads only the first bytes of a large blob and says so', async () => {
    const read = await readBlobText(new Blob(['abcdefghij']), 4);
    expect(read).toEqual({ text: 'abcd', truncated: true });
  });
});
