/**
 * Helpers for the inline preview of a result file: what kind of text it is, a
 * capped decode of its start, and small bounded parsers. Pure.
 */

/** The most a preview reads of one file. */
export const PREVIEW_MAX_BYTES = 200 * 1024;
/** A preview opens by itself only for a file known to be this small or smaller. */
export const PREVIEW_AUTO_OPEN_MAX_BYTES = 100 * 1024;
/** How many CSV rows a preview shows, header included. */
export const PREVIEW_CSV_ROWS = 10;
/** The widest CSV row, and the longest cell, a preview shows. */
export const PREVIEW_CSV_COLUMNS = 50;
export const PREVIEW_CSV_CELL_CHARS = 500;
/** JSON is indented only up to this size and nesting depth. */
export const PREVIEW_JSON_MAX_CHARS = 150_000;
export const PREVIEW_JSON_MAX_DEPTH = 64;

export type PreviewKind = 'markdown' | 'csv' | 'json';

/** What a file can be previewed as, from its name; null when it cannot. */
export function previewKind(name: string): PreviewKind | null {
  const extension = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name)?.[1]?.toLowerCase();
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'csv') return 'csv';
  if (extension === 'json') return 'json';
  return null;
}

/** Decode the bytes of a file's start as text (a cut multi-byte character becomes a replacement mark). */
export function decodePreviewText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * The first `maxRows` rows of CSV text, with quoted fields and doubled quotes
 * read. `truncated` is true when more rows followed, a row was wider than
 * `PREVIEW_CSV_COLUMNS`, or a cell was longer than `PREVIEW_CSV_CELL_CHARS`.
 */
export function parseCsvRows(
  text: string,
  maxRows = PREVIEW_CSV_ROWS,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let truncated = false;
  let more = false;
  const addField = () => {
    if (row.length < PREVIEW_CSV_COLUMNS) row.push(field);
    else truncated = true;
    field = '';
  };
  const addChar = (char: string) => {
    if (field.length < PREVIEW_CSV_CELL_CHARS) field += char;
    else truncated = true;
  };
  const endRow = () => {
    addField();
    if (row.some((cell) => cell !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    if (rows.length >= maxRows) {
      more = text.slice(i).trim() !== '';
      break;
    }
    const char = text[i] as string;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        addChar('"');
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        addChar(char);
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      addField();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
    } else {
      addChar(char);
    }
  }
  if (rows.length < maxRows && (field !== '' || row.length > 0)) endRow();
  return { rows, truncated: truncated || more };
}

/** The deepest nesting of `{` and `[` outside strings, stopping early once past `limit`. */
function jsonDepth(text: string, limit: number): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
      if (depth > deepest) deepest = depth;
      if (deepest > limit) return deepest;
    } else if (char === '}' || char === ']') {
      depth -= 1;
    }
  }
  return deepest;
}

/**
 * JSON text indented. It is shown as it was, with a note saying why, when it is
 * cut off (only its start was read), too large, too deeply nested, or does not parse.
 */
export function prettyJson(
  text: string,
  options: { truncated?: boolean } = {},
): { text: string; note?: string } {
  if (options.truncated) {
    return { text, note: 'Only the start of this file was read, so it is shown as it is.' };
  }
  if (text.length > PREVIEW_JSON_MAX_CHARS) {
    return { text, note: 'This file is too large to indent, so it is shown as it is.' };
  }
  if (jsonDepth(text, PREVIEW_JSON_MAX_DEPTH) > PREVIEW_JSON_MAX_DEPTH) {
    return { text, note: 'This file is nested too deeply to indent, so it is shown as it is.' };
  }
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2) };
  } catch {
    return { text, note: 'This file is not valid JSON, so it is shown as it is.' };
  }
}
