import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/auth/token-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/token-store')>()),
  getAccessToken: () => 'tok',
}));

import { renderWithProviders } from '@/test/utils/render';
import { CredentialsPage } from '../CredentialsPage';

type Row = { name: string; fields: string[]; updated_at?: string; last_used_at?: string | null };

function stubAdapter(opts: { rows?: Row[]; putStatus?: number; putCode?: string } = {}) {
  const rows = opts.rows ?? [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => ({
      ok: status < 400,
      status,
      json: async () => body,
    });
    if (init?.method === 'PUT') {
      if (opts.putStatus && opts.putStatus >= 400) {
        return json(opts.putStatus, { detail: { code: opts.putCode } });
      }
      return json(200, { name: 'x', fields: [] });
    }
    if (init?.method === 'DELETE') return json(200, {});
    return json(200, rows);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calls = (m: ReturnType<typeof stubAdapter>, method: string) =>
  m.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method);

beforeEach(() => {
  window.__MINT_CONFIG__ = { ENSEMBLE_MANAGER_API: 'http://em/v1' } as never;
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { __MINT_CONFIG__?: unknown }).__MINT_CONFIG__;
});

const row: Row = {
  name: 'model_server',
  fields: ['api_key', 'chat_base_url'],
  updated_at: '2026-11-01T10:00:00Z',
  last_used_at: null,
};

describe('CredentialsPage', () => {
  it('lists name, field names, last changed and last used, never values', async () => {
    stubAdapter({ rows: [row] });
    renderWithProviders(<CredentialsPage />);
    const card = await screen.findByTestId('credential-model_server');
    expect(card).toHaveTextContent('api_key, chat_base_url');
    expect(card).toHaveTextContent(/last used: never/i);
    expect(screen.getByText(/never appears in your threads or runs/i)).toBeInTheDocument();
  });

  it('adds the Model server preset and clears the form after saving', async () => {
    const fetchMock = stubAdapter();
    renderWithProviders(<CredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add a model server/i }));
    expect(screen.getByLabelText('Name')).toHaveValue('model_server');
    expect(screen.getByLabelText('Field name 1')).toHaveValue('api_key');
    expect(screen.getByLabelText('Field name 2')).toHaveValue('chat_base_url');
    expect(screen.getByLabelText('Field name 3')).toHaveValue('embedding_base_url');
    const values = [1, 2, 3].map((n) => screen.getByLabelText(`Value ${n}`));
    values.forEach((v) => expect(v).toHaveAttribute('type', 'password'));
    values.forEach((v, i) => fireEvent.change(v, { target: { value: `SECRET${i}` } }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(calls(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = calls(fetchMock, 'PUT')[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://em/v1/secrets/model_server');
    expect(JSON.parse(String(init.body))).toEqual({
      fields: { api_key: 'SECRET0', chat_base_url: 'SECRET1', embedding_base_url: 'SECRET2' },
    });
    await waitFor(() => expect(screen.queryByLabelText('Value 1')).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain('SECRET');
    expect(JSON.stringify({ ...localStorage })).not.toContain('SECRET');
    expect(screen.getByRole('status')).toHaveTextContent(/saved/i);
  });

  it('shows a typed value on request, warns about spaces and quotes, and saves it trimmed', async () => {
    const fetchMock = stubAdapter();
    renderWithProviders(<CredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add a model server/i }));
    const key = screen.getByLabelText('Value 1');
    fireEvent.change(key, { target: { value: ' sk-abc ' } });
    expect(screen.getByText(/starts or ends with a space/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show value 1' }));
    expect(key).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide value 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hide value 1' }));
    expect(key).toHaveAttribute('type', 'password');
    // The other values stay hidden.
    expect(screen.getByLabelText('Value 2')).toHaveAttribute('type', 'password');

    fireEvent.change(screen.getByLabelText('Value 2'), { target: { value: '"https://chat"' } });
    expect(screen.getByText(/starts or ends with a quote mark/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Value 2'), { target: { value: 'https://chat' } });
    fireEvent.change(screen.getByLabelText('Value 3'), { target: { value: 'https://embed' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(calls(fetchMock, 'PUT')).toHaveLength(1));
    const [, init] = calls(fetchMock, 'PUT')[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).fields.api_key).toBe('sk-abc');
  });

  it('checks the rules before sending', async () => {
    const fetchMock = stubAdapter();
    renderWithProviders(<CredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add a credential/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bad Name' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/name must be/i);
    expect(calls(fetchMock, 'PUT')).toHaveLength(0);
  });

  it('replaces by re-entering every field and says values are not shown', async () => {
    const fetchMock = stubAdapter({ rows: [row] });
    renderWithProviders(<CredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^replace$/i }));
    expect(screen.getByText(/enter every field again/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Value 1')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Value 1'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Value 2'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(calls(fetchMock, 'PUT')).toHaveLength(1));
    const init = calls(fetchMock, 'PUT')[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      fields: { api_key: 'a', chat_base_url: 'b' },
    });
  });

  it('deletes only after the confirm', async () => {
    const fetchMock = stubAdapter({ rows: [row] });
    renderWithProviders(<CredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    expect(calls(fetchMock, 'DELETE')).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i, hidden: false }));
    await waitFor(() => expect(calls(fetchMock, 'DELETE')).toHaveLength(1));
    expect(String(calls(fetchMock, 'DELETE')[0]![0])).toBe('http://em/v1/secrets/model_server');
  });

  it('explains a run-in-progress lock', async () => {
    stubAdapter({ rows: [row], putStatus: 409, putCode: 'SECRET_LOCKED_BY_RUN' });
    renderWithProviders(<CredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^replace$/i }));
    fireEvent.change(screen.getByLabelText('Value 1'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Value 2'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You have a run in progress. Change this credential when it has finished.',
    );
  });

  it('explains a rate limit', async () => {
    stubAdapter({ putStatus: 429, putCode: 'SECRET_RATE_LIMITED' });
    renderWithProviders(<CredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add a credential/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('Field name 1'), { target: { value: 'k' } });
    fireEvent.change(screen.getByLabelText('Value 1'), { target: { value: 'v' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many times/i);
  });
});
