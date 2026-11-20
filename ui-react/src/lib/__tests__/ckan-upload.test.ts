import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  UPLOAD_BYTES_CAP,
  UPLOAD_FILE_CAP,
  UPLOAD_UNREACHABLE_MESSAGE,
  UploadError,
  checkUploadAgainstInput,
  listUploadOrganizations,
  regionToSpatial,
  sanitizeUploadNames,
  uploadBatchProblem,
  uploadFilesToCatalog,
} from '@/lib/ckan-upload';
import { setMintConfig } from '@/test/utils/mint-config';

const CKAN = 'https://ckan.example.org';

interface Sent {
  url: string;
  headers: Record<string, string>;
  form: FormData;
}
let sent: Sent[] = [];
/** What each resource_create does: a status, or 'network' for a blocked request. */
let behaviour: Array<number | 'network'> = [];
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
/** The resources package_show answers with (default: what was uploaded, complete). */
let shownResources: ((made: Sent[]) => Array<Record<string, unknown>>) | null = null;

class FakeXhr {
  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 0;
  responseText = '';
  private record: Sent = { url: '', headers: {}, form: new FormData() };
  open(_method: string, url: string) {
    this.record.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.record.headers[name] = value;
  }
  send(form: FormData) {
    this.record.form = form;
    sent.push(this.record);
    const n = sent.length;
    const outcome = behaviour.shift() ?? 200;
    queueMicrotask(() => {
      if (outcome === 'network') {
        this.onerror?.();
        return;
      }
      const file = form.get('upload') as File;
      this.upload.onprogress?.({ loaded: file.size });
      this.status = outcome;
      this.responseText =
        outcome >= 400
          ? JSON.stringify({ success: false, error: { message: 'no way' } })
          : JSON.stringify({ success: true, result: { id: `res-${n}`, url: `${CKAN}/d/${n}` } });
      this.onload?.();
    });
  }
}

function file(name: string, size = 3): File {
  return new File(['x'.repeat(size)], name);
}

const BASE = {
  organizationId: 'org-1',
  isPublic: false,
  flowName: 'Sensemaking',
  inputName: 'Corpus',
  variables: ['sv-doc'],
  format: 'directory',
  multiple: true,
  username: 'alice',
  now: new Date('2026-11-19T10:00:00Z'),
};

beforeEach(() => {
  sent = [];
  behaviour = [];
  fetchCalls = [];
  shownResources = null;
  localStorage.setItem('mint.access_token', 'USER-TOKEN');
  setMintConfig({ AUTH_PROVIDER: 'tapis', DATA_CATALOG_API: CKAN } as never);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes('package_create')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ success: true, result: { id: 'pkg-1', name: 'dynamo-upload-x' } }),
        };
      }
      if (u.includes('package_show')) {
        const rows = shownResources
          ? shownResources(sent)
          : sent.map((s, i) => ({
              id: `res-${i + 1}`,
              name: (s.form.get('upload') as File).name,
              url: `${CKAN}/d/${i + 1}`,
              mint_standard_variables: s.form.get('mint_standard_variables'),
            }));
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { id: 'pkg-1', resources: rows } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: [
            { id: 'o2', name: 'b', title: 'B org' },
            { id: 'o1', name: 'a', title: 'A org' },
          ],
        }),
      };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('sanitizeUploadNames', () => {
  it('replaces unsafe characters and drops a leading dot', () => {
    expect(sanitizeUploadNames(['my file (1).csv', '.hidden'])).toEqual([
      'my_file_1_.csv',
      'hidden',
    ]);
  });
  it('numbers repeats before the extension, ignoring case', () => {
    expect(sanitizeUploadNames(['a.csv', 'A.csv', 'a.csv'])).toEqual([
      'a.csv',
      'A-2.csv',
      'a-3.csv',
    ]);
  });
  it('names a file with nothing usable by its position', () => {
    expect(sanitizeUploadNames(['ok.txt', '...'])).toEqual(['ok.txt', 'resource-1']);
  });
});

describe('uploadBatchProblem', () => {
  it('caps the batch at 500 files and 2 GB', () => {
    const many = Array.from({ length: UPLOAD_FILE_CAP + 1 }, () => ({ size: 1 }));
    expect(uploadBatchProblem(many)).toMatch(/At most 500 files/);
    expect(uploadBatchProblem([{ size: UPLOAD_BYTES_CAP + 1 }])).toMatch(/2 GB/);
    expect(uploadBatchProblem([{ size: UPLOAD_BYTES_CAP }])).toBeNull();
    expect(uploadBatchProblem([])).toMatch(/at least one/);
  });
});

describe('checkUploadAgainstInput', () => {
  const base = { variables: ['v'], multiple: false, inputName: 'Config' };
  it('takes no standard variable for a file that belongs to no input', () => {
    expect(
      checkUploadAgainstInput({
        ...base,
        variables: [],
        variableOptional: true,
        files: [{ name: 'a.json' }],
      }).error,
    ).toBeNull();
  });
  it('refuses an input with no standard variable', () => {
    const r = checkUploadAgainstInput({ ...base, variables: [], files: [{ name: 'a.json' }] });
    expect(r.error).toMatch(/names no standard variable/);
  });
  it('matches a single file by extension, ignoring case', () => {
    expect(
      checkUploadAgainstInput({ ...base, format: 'json', files: [{ name: 'A.JSON' }] }).error,
    ).toBeNull();
    expect(
      checkUploadAgainstInput({ ...base, format: '.CSV', files: [{ name: 'a.csv' }] }).error,
    ).toBeNull();
    expect(
      checkUploadAgainstInput({ ...base, format: 'text/csv', files: [{ name: 'a.csv' }] }).error,
    ).toBeNull();
    expect(
      checkUploadAgainstInput({ ...base, format: 'yaml', files: [{ name: 'a.yml' }] }).error,
    ).toBeNull();
  });
  it('refuses a mismatch with a sentence naming both', () => {
    const r = checkUploadAgainstInput({ ...base, format: 'json', files: [{ name: 'notes.pdf' }] });
    expect(r.error).toBe('The input "Config" reads json files, but "notes.pdf" is a .pdf file.');
    expect(
      checkUploadAgainstInput({ ...base, format: 'json', files: [{ name: 'README' }] }).error,
    ).toMatch(/no extension/);
  });
  it('takes any files for a collection of format directory', () => {
    const r = checkUploadAgainstInput({
      ...base,
      multiple: true,
      format: 'directory',
      files: [{ name: 'a.pdf' }, { name: 'b' }],
    });
    expect(r).toEqual({ error: null, notes: [] });
  });
  it('refuses a folder format for a single file', () => {
    expect(
      checkUploadAgainstInput({ ...base, format: 'directory', files: [{ name: 'a.txt' }] }).error,
    ).toMatch(/reads a folder/);
  });
  it('checks every file of a collection with a file format', () => {
    const r = checkUploadAgainstInput({
      ...base,
      multiple: true,
      format: 'pdf',
      files: [{ name: 'a.pdf' }, { name: 'b.md' }],
    });
    expect(r.error).toMatch(/"b.md" is a .md file/);
  });
  it('accepts an undeclared format and says so', () => {
    const r = checkUploadAgainstInput({ ...base, format: null, files: [{ name: 'a.bin' }] });
    expect(r.error).toBeNull();
    expect(r.notes[0]).toMatch(/does not declare a file format/);
  });
  it('allows one file only for an ordinary input', () => {
    expect(
      checkUploadAgainstInput({
        ...base,
        format: 'json',
        files: [{ name: 'a.json' }, { name: 'b.json' }],
      }).error,
    ).toMatch(/takes one file/);
  });
});

describe('regionToSpatial', () => {
  it('turns a region into the bounding polygon the data step reads', () => {
    const geo = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    };
    expect(JSON.parse(regionToSpatial([geo])!)).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    });
    expect(regionToSpatial(undefined)).toBeNull();
  });
});

describe('listUploadOrganizations', () => {
  it('asks as the user for organisations they may create datasets in', async () => {
    const orgs = await listUploadOrganizations();
    expect(orgs.map((o) => o.title)).toEqual(['A org', 'B org']);
    expect(fetchCalls[0]!.url).toBe(
      `${CKAN}/api/3/action/organization_list_for_user?permission=create_dataset`,
    );
    expect(fetchCalls[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer USER-TOKEN' });
  });
});

describe('uploadFilesToCatalog', () => {
  it('makes a private dataset, one resource per file, and re-reads it before returning', async () => {
    const progress = vi.fn();
    const geo = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    };
    const result = await uploadFilesToCatalog({
      ...BASE,
      files: [file('a b.txt'), file('c.txt', 5)],
      startDate: '2001-02-03',
      endDate: '2004-05-06T00:00:00',
      regionGeometry: [geo],
      onProgress: progress,
    });

    const create = fetchCalls.find((c) => c.url.includes('package_create'))!;
    expect(create.init?.headers).toMatchObject({ Authorization: 'Bearer USER-TOKEN' });
    const body = JSON.parse(String(create.init?.body));
    expect(body).toMatchObject({
      type: 'dataset',
      owner_org: 'org-1',
      private: true,
      title: 'Uploaded files, 2026-11-19, alice',
      notes: 'Uploaded through DYNAMO for Sensemaking / Corpus.',
      temporal_coverage_start: '2001-02-03',
      temporal_coverage_end: '2004-05-06',
      tag_string: 'dynamo-upload',
    });
    expect(body.name).toMatch(/^dynamo-upload-2026-11-19-[0-9a-f]{8}$/);
    expect(JSON.parse(body.spatial).type).toBe('Polygon');

    expect(sent.map((s) => s.url)).toEqual([
      `${CKAN}/api/3/action/resource_create`,
      `${CKAN}/api/3/action/resource_create`,
    ]);
    expect(sent[0]!.headers).toEqual({ Authorization: 'Bearer USER-TOKEN' });
    expect(sent[0]!.form.get('package_id')).toBe('pkg-1');
    expect(sent[0]!.form.get('name')).toBe('a_b.txt');
    expect(sent[0]!.form.get('format')).toBe('TXT');
    expect(sent[0]!.form.get('mint_standard_variables')).toBe('sv-doc');
    expect((sent[0]!.form.get('upload') as File).name).toBe('a_b.txt');
    // Re-read as the user before the input is bound.
    expect(fetchCalls.some((c) => c.url.includes('package_show'))).toBe(true);
    expect(result.datasetId).toBe('dynamo-upload-x');
    expect(result.resources.map((r) => r.url)).toEqual([`${CKAN}/d/1`, `${CKAN}/d/2`]);
    expect(progress.mock.calls.at(-1)![0]).toMatchObject({ sent: 8, total: 8, count: 2 });
  });

  it('takes an edit that belongs to no input: no standard variable asked, none recorded', async () => {
    const result = await uploadFilesToCatalog({
      ...BASE,
      variables: [],
      variableOptional: true,
      multiple: false,
      format: 'json',
      notes: 'An edited copy.',
      files: [file('lexicon.json')],
    });
    const body = JSON.parse(
      String(fetchCalls.find((c) => c.url.includes('package_create'))!.init?.body),
    );
    expect(body).toMatchObject({ private: true, notes: 'An edited copy.' });
    expect(sent[0]!.form.has('mint_standard_variables')).toBe(false);
    expect(result.resources[0]!.url).toBe(`${CKAN}/d/1`);
  });

  it('still refuses an input with no standard variable unless that is allowed', async () => {
    await expect(
      uploadFilesToCatalog({ ...BASE, variables: [], files: [file('a.txt')] }),
    ).rejects.toThrow(/names no standard variable/);
    expect(sent).toEqual([]);
  });

  it('makes the dataset public only when asked', async () => {
    await uploadFilesToCatalog({ ...BASE, isPublic: true, files: [file('a.txt')] });
    const body = JSON.parse(
      String(fetchCalls.find((c) => c.url.includes('package_create'))!.init?.body),
    );
    expect(body.private).toBe(false);
  });

  it('covers today, with no region, when the thread has neither', async () => {
    await uploadFilesToCatalog({ ...BASE, files: [file('a.txt')], startDate: null, endDate: null });
    const body = JSON.parse(
      String(fetchCalls.find((c) => c.url.includes('package_create'))!.init?.body),
    );
    expect(body.temporal_coverage_start).toBe('2026-11-19');
    expect(body.temporal_coverage_end).toBe('2026-11-19');
    expect(body.spatial).toBeUndefined();
  });

  it('uploads one file for an ordinary input as an individual dataset', async () => {
    const result = await uploadFilesToCatalog({
      ...BASE,
      multiple: false,
      format: 'json',
      inputName: 'Config',
      files: [file('c.json')],
    });
    expect(result.resources).toHaveLength(1);
    expect(sent[0]!.form.get('format')).toBe('JSON');
  });

  it('creates nothing when the file does not match the input', async () => {
    await expect(
      uploadFilesToCatalog({ ...BASE, multiple: false, format: 'json', files: [file('a.pdf')] }),
    ).rejects.toThrow(/reads json files, but "a.pdf" is a .pdf file/);
    await expect(
      uploadFilesToCatalog({ ...BASE, variables: [], files: [file('a.txt')] }),
    ).rejects.toThrow(/no standard variable/);
    expect(fetchCalls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('refuses a batch over the caps before calling anything', async () => {
    const big = { name: 'big', size: UPLOAD_BYTES_CAP + 1 } as File;
    await expect(uploadFilesToCatalog({ ...BASE, files: [big] })).rejects.toThrow(/2 GB/);
    expect(fetchCalls).toEqual([]);
  });

  it('stops with a plain message when the browser cannot reach the catalog on the first file', async () => {
    behaviour = ['network'];
    const error = await uploadFilesToCatalog({ ...BASE, files: [file('a'), file('b')] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).message.startsWith(UPLOAD_UNREACHABLE_MESSAGE)).toBe(true);
    expect((error as UploadError).message).toMatch(/was created and keeps the files/);
    expect(sent).toHaveLength(1);
  });

  it('names the file and the dataset left behind when a later file fails', async () => {
    behaviour = [200, 403];
    await expect(
      uploadFilesToCatalog({ ...BASE, files: [file('a'), file('b.txt')] }),
    ).rejects.toThrow(
      /Could not upload b\.txt: HTTP 403: no way\. The dataset "Uploaded files, 2026-11-19, alice" was created/,
    );
    expect(fetchCalls.some((c) => c.url.includes('package_show'))).toBe(false);
  });

  it('shows what is missing when the re-read dataset is not ready, and binds nothing', async () => {
    shownResources = () => [{ id: 'res-1', name: 'a.txt', url: '', mint_standard_variables: '' }];
    await expect(uploadFilesToCatalog({ ...BASE, files: [file('a.txt')] })).rejects.toThrow(
      /a\.txt: no download address; a\.txt: the standard variable is not recorded/,
    );
  });

  it('needs a signed-in user', async () => {
    localStorage.clear();
    await expect(uploadFilesToCatalog({ ...BASE, files: [file('a')] })).rejects.toThrow(/Sign in/);
  });
});
