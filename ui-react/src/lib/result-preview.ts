/**
 * Helpers for the inline preview of a result file: what kind of text it is, a
 * capped read of its content, and small parsers. Pure, apart from the blob read.
 */

/** The most a preview reads of one file. */
export const PREVIEW_MAX_BYTES = 200 * 1024;
/** How many CSV rows a preview shows, header included. */
export const PREVIEW_CSV_ROWS = 10;

export type PreviewKind = 'markdown' | 'csv' | 'json';

/** What a file can be previewed as, from its name; null when it cannot. */
export function previewKind(name: string): PreviewKind | null {
  const extension = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name)?.[1]?.toLowerCase();
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'csv') return 'csv';
  if (extension === 'json') return 'json';
  return null;
}

/** The first `maxBytes` of a blob as text, and whether the rest was left out. */
export async function readBlobText(
  blob: Blob,
  maxBytes = PREVIEW_MAX_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  const part = blob.size > maxBytes ? blob.slice(0, maxBytes) : blob;
  const text =
    typeof part.text === 'function'
      ? await part.text()
      : await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.onerror = () => reject(reader.error);
          reader.readAsText(part);
        });
  return { text, truncated: blob.size > maxBytes };
}

/** The first `maxRows` rows of CSV text, with quoted fields and doubled quotes read. */
export function parseCsvRows(text: string, maxRows = PREVIEW_CSV_ROWS): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((cell) => cell !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length && rows.length < maxRows; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
    } else {
      field += char;
    }
  }
  if (rows.length < maxRows && (field !== '' || row.length > 0)) endRow();
  return rows.slice(0, maxRows);
}

/** JSON text indented, or the text as it was when it does not parse (a cut-off file). */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
