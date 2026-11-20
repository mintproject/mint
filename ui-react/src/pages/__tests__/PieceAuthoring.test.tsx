import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PieceApprovalPage } from '@/pages/PieceApprovalPage';
import { PieceApprovalsPage } from '@/pages/PieceApprovalsPage';
import { PieceFromRepositoryPage } from '@/pages/PieceFromRepositoryPage';
import { renderWithProviders } from '@/test/utils/render';
import { setMintConfig } from '@/test/utils/mint-config';

// The picker reads the whole standard-variable catalog; here it is a button.
vi.mock('@/components/autocomplete/StandardVariableCombobox', () => ({
  StandardVariableCombobox: ({
    onChange,
    placeholder,
  }: {
    onChange: (o: { id: string; label: string; description: null }) => void;
    placeholder?: string;
  }) => (
    <button
      type="button"
      onClick={() =>
        onChange({
          id: `https://x/${placeholder?.includes('input') ? 'in' : 'out'}`,
          label: 'v',
          description: null,
        })
      }
    >
      {placeholder}
    </button>
  ),
}));

const SHA = '0123456789abcdef0123456789abcdef01234567';

function adapter(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const body = handler(String(input), init);
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

beforeEach(() => {
  setMintConfig({ ENSEMBLE_MANAGER_API: 'http://em.test/v1' });
  localStorage.setItem('mint.access_token', 'tok');
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const preview = {
  dry_run: true,
  process_id: 'https://id/p1',
  label: 'Clean',
  description: '',
  version: '1.0.0',
  visibility: 'private',
  origin: {
    repository: 'org/repo',
    commit: SHA,
    path: 'p.py',
    url: '',
    sha256: 'h',
    fetched_at: '',
  },
  entrypoint: 'run',
  source: 'def run(i):\n    return 1\n',
  source_sha256: 'deadbeef',
  source_bytes: 25,
  contracts: [{ role: 'input', position: 0, standard_variable_uri: 'https://x/in' }],
  arguments: {},
  required: [],
  env_from_args: {},
  secrets: [],
  sends_data_to: [],
  warnings: [],
  approval_sha256: 'approvalhash',
};

describe('Register a piece', () => {
  function fill() {
    const type = (label: RegExp, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    type(/^name$/i, 'Clean');
    type(/^repository$/i, 'org/repo');
    type(/^commit$/i, SHA);
    type(/path to the source/i, 'p.py');
    fireEvent.click(screen.getByRole('button', { name: /choose input variable/i }));
    fireEvent.click(screen.getByRole('button', { name: /choose output variable/i }));
  }

  it('explains what is wrong with a branch name and sends nothing', () => {
    const fetchMock = adapter(() => preview);
    renderWithProviders(<PieceFromRepositoryPage />);
    fill();
    fireEvent.change(screen.getByLabelText(/^commit$/i), { target: { value: 'main' } });
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/40-character/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows what will be stored before writing, then registers it', async () => {
    const bodies: Array<{ dry_run: boolean; process_id?: string }> = [];
    adapter((_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return body.dry_run
        ? preview
        : { ...preview, dry_run: false, status: 'created', owner_username: 'alice' };
    });
    renderWithProviders(<PieceFromRepositoryPage />);
    const register = screen.getByRole('button', { name: /register this piece/i });
    expect(register).toBeDisabled();
    fill();
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    await screen.findByText(/what will be stored/i);
    expect(screen.getByText('deadbeef')).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /register this piece/i }));
    await screen.findByText(/registered/i);
    expect(bodies[1]).toMatchObject({ dry_run: false });
    expect(bodies[1]).not.toHaveProperty('process_id');
  });

  it('forgets the preview when the form changes', async () => {
    adapter(() => preview);
    renderWithProviders(<PieceFromRepositoryPage />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    await screen.findByText(/what will be stored/i);
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Other' } });
    expect(screen.queryByText(/what will be stored/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /register this piece/i })).toBeDisabled();
  });
});

const summary = (over: object) => ({
  spec_id: 'https://id/a',
  label: 'A',
  version: '1',
  owner_username: 'alice',
  visibility: 'public',
  source_sha256: 'h',
  origin: null,
  approved: false,
  lapsed: false,
  approved_sha256: null,
  approval_sha256: 'ah',
  approved_by: null,
  approved_at: null,
  ...over,
});

describe('Approvals list', () => {
  it('splits awaiting from approved and leaves private pieces out', async () => {
    adapter(() => ({
      is_admin: false,
      pieces: [
        summary({ spec_id: 'https://id/a', label: 'Waiting' }),
        summary({ spec_id: 'https://id/b', label: 'Done', approved: true, approved_by: 'root' }),
        summary({ spec_id: 'https://id/c', label: 'Mine', visibility: 'private' }),
      ],
    }));
    renderWithProviders(<PieceApprovalsPage />);
    await screen.findByText('Waiting');
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.queryByText('Mine')).not.toBeInTheDocument();
    expect(screen.getByText(/only administrators can approve/i)).toBeInTheDocument();
    expect(screen.getByText(/approved by root/i)).toBeInTheDocument();
  });
});

describe('Approval page', () => {
  const detail = (over: object) => ({
    ...summary({}),
    is_admin: true,
    description: null,
    process_id: 'https://id/a',
    source: 'def run(i):\n    return 1\n',
    entrypoint: 'run',
    env_from_args: { TOP_N: 'top_n' },
    arguments: { properties: { top_n: { type: 'integer', default: 25 } } },
    secrets: [{ name: 'k', label: 'Key', env: { API_KEY: 'key' } }],
    sends_data_to: [{ service: 'api.example.com', what: 'the text' }],
    contracts: [
      { role: 'input', standard_variable_uri: 'https://x/in', unit: null, format: 'csv' },
    ],
    history: [],
    ...over,
  });

  function open(state: object) {
    const calls: Array<{ method?: string; body?: string }> = [];
    adapter((_url, init) => {
      calls.push({ method: init?.method, body: init?.body as string | undefined });
      return init?.method === 'PUT' ? { approved: true } : detail(state);
    });
    renderWithProviders(
      <Routes>
        <Route path="/etl/approvals/:specId" element={<PieceApprovalPage />} />
      </Routes>,
      { initialEntries: ['/etl/approvals/https%3A%2F%2Fid%2Fa'] },
    );
    return calls;
  }

  it('shows exactly what is approved', async () => {
    open({});
    await screen.findByText(/what an approval covers/i);
    expect(screen.getByText('ah')).toBeInTheDocument();
    expect(screen.getByText(/api.example.com/)).toBeInTheDocument();
    expect(screen.getByText(/fills API_KEY from key/)).toBeInTheDocument();
    expect(screen.getByText(/top_n/, { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText(/def run/)).toBeInTheDocument();
  });

  it('lets an admin approve only after a confirmation, sending the hash shown', async () => {
    const calls = open({});
    fireEvent.click(await screen.findByRole('button', { name: /approve this piece/i }));
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({
      approved: true,
      reviewed_sha256: 'ah',
    });
  });

  it('offers withdrawal, with a confirmation, for an approved piece', async () => {
    const calls = open({ approved: true, approved_by: 'root', approved_at: 'then' });
    expect(screen.queryByRole('button', { name: /approve this piece/i })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /withdraw approval/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^withdraw$/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!).approved).toBe(false);
  });

  it('is read-only for someone who is not an admin', async () => {
    open({ is_admin: false });
    await screen.findByText(/read-only/i);
    expect(screen.queryByRole('button', { name: /approve this piece/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /withdraw/i })).not.toBeInTheDocument();
  });

  it('says whether the origin was verified in the repository history', async () => {
    const origin = {
      repository: 'org/repo',
      commit: SHA,
      path: 'p.py',
      url: '',
      sha256: 'h',
      fetched_at: '',
    };
    const verified = open({ origin: { ...origin, verified_on_branch: 'main' } });
    void verified;
    await screen.findByText("verified in org/repo's main history");
  });

  it('says UNVERIFIED when the commit was not confirmed', async () => {
    const origin = {
      repository: 'org/repo',
      commit: SHA,
      path: 'p.py',
      url: '',
      sha256: 'h',
      fetched_at: '',
    };
    open({ origin });
    await screen.findByText(/UNVERIFIED — read the source/);
  });

  it('says when an approval lapsed because the piece changed', async () => {
    open({ lapsed: true });
    await screen.findByText(/approval lapsed/i);
  });
});
