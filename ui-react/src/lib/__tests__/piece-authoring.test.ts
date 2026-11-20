import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildRequest,
  formProblems,
  getApproval,
  initialPieceForm,
  listApprovals,
  normalizeRepository,
  originVerification,
  PieceApiError,
  registerPiece,
  setApproval,
  type PieceFormState,
} from '@/lib/piece-authoring';
import { setMintConfig } from '@/test/utils/mint-config';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function filled(over: Partial<PieceFormState> = {}): PieceFormState {
  return {
    ...initialPieceForm(),
    label: 'Clean',
    repository: 'org/repo',
    commit: SHA,
    path: 'pieces/clean.py',
    inputs: [{ standardVariableUri: 'https://x/in', format: 'csv', unit: '' }],
    outputs: [{ standardVariableUri: 'https://x/out', format: '', unit: 'm' }],
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the form', () => {
  it('accepts a complete form', () => {
    expect(formProblems(filled())).toEqual([]);
  });

  it.each(['main', 'v1.0', SHA.slice(0, 7), `${SHA}0`, ''])('refuses %j as a commit', (commit) => {
    expect(formProblems(filled({ commit })).join(' ')).toMatch(/40-character/);
  });

  it('asks for a .py path, a repository, an entrypoint and both contracts', () => {
    const problems = formProblems(
      filled({ path: 'a.txt', repository: 'nope', entrypoint: '1x', inputs: [], outputs: [] }),
    );
    expect(problems.length).toBe(5);
  });

  it('takes a pasted GitHub address', () => {
    expect(normalizeRepository(' https://github.com/org/repo.git/ ')).toBe('org/repo');
  });

  it('builds the request from the form, never with source code', () => {
    const request = buildRequest(
      filled({
        commit: SHA.toUpperCase(),
        arguments: [
          { name: 'top_n', type: 'integer', defaultText: '25', description: '', required: true },
        ],
        secrets: [{ name: 'k', label: '', envText: 'API_KEY=key\n' }],
        sends: [{ service: 'api.example.com', what: 'text' }],
      }),
      true,
    );
    expect(request).toMatchObject({
      commit: SHA,
      dry_run: true,
      inputs: [{ standard_variable_uri: 'https://x/in', format: 'csv' }],
      outputs: [{ standard_variable_uri: 'https://x/out', unit: 'm' }],
      arguments: [{ name: 'top_n', type: 'integer', default: 25, required: true }],
      secrets: [{ name: 'k', label: 'k', env: { API_KEY: 'key' } }],
      sends_data_to: [{ service: 'api.example.com', what: 'text' }],
    });
    expect(Object.keys(request)).not.toContain('source');
    // The id is the adapter's to choose.
    expect(Object.keys(request)).not.toContain('process_id');
  });
});

describe('the adapter calls', () => {
  function adapter(response: unknown, status = 200) {
    setMintConfig({ SVO_ADAPTER_API: 'http://adapter.test/' });
    localStorage.setItem('mint.access_token', 'tok-1');
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(response), { status }));
  }

  it('registers with the stored bearer token', async () => {
    const fetchMock = adapter({ dry_run: true, process_id: 'p' });
    await registerPiece(buildRequest(filled(), true));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://adapter.test/pieces/from-repository');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect(JSON.parse(init.body as string).dry_run).toBe(true);
  });

  it('refuses to call without a token', async () => {
    setMintConfig({ SVO_ADAPTER_API: 'http://adapter.test' });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(listApprovals()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the adapter refusal code and message', async () => {
    adapter({ detail: { code: 'PIECE_COMMIT_INVALID', message: 'use a full SHA' } }, 422);
    const error = (await registerPiece(buildRequest(filled(), true)).catch(
      (e) => e,
    )) as PieceApiError;
    expect(error).toBeInstanceOf(PieceApiError);
    expect(error.code).toBe('PIECE_COMMIT_INVALID');
    expect(error.message).toBe('use a full SHA');
  });

  it('encodes the piece id in the approval path and sends the reviewed hash', async () => {
    const fetchMock = adapter({ approved: true });
    await setApproval('https://w3id.org/etl/a', true, 'abc');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://adapter.test/transform-specs/https%3A%2F%2Fw3id.org%2Fetl%2Fa/approval',
    );
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ approved: true, reviewed_sha256: 'abc' });
    await getApproval('x');
  });
});

describe('origin wording', () => {
  const origin = {
    repository: 'org/repo',
    commit: SHA,
    path: 'p.py',
    url: '',
    sha256: 'h',
    fetched_at: '',
  };
  it('says where the commit was confirmed', () => {
    expect(originVerification({ ...origin, verified_on_branch: 'main' })).toBe(
      "verified in org/repo's main history",
    );
  });
  it('says UNVERIFIED when GitHub did not confirm it, or for an older piece', () => {
    expect(originVerification(origin)).toMatch(/^UNVERIFIED/);
    expect(originVerification({ ...origin, verified_on_branch: null })).toMatch(/^UNVERIFIED/);
    expect(originVerification(null)).toMatch(/^UNVERIFIED/);
  });
});
