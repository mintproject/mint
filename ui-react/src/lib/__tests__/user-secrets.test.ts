import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/token-store', () => ({ getAccessToken: () => 'tok' }));

import {
  deleteUserSecret,
  listUserSecrets,
  saveUserSecret,
  UserSecretError,
  validateUserSecret,
} from '@/lib/user-secrets';

const respond = (status: number, body: unknown = {}) =>
  vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));

beforeEach(() => {
  window.__MINT_CONFIG__ = { SVO_ADAPTER_API: 'http://adapter/' } as never;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { __MINT_CONFIG__?: unknown }).__MINT_CONFIG__;
});

describe('user secrets API', () => {
  it('lists with the bearer token', async () => {
    const fetchMock = respond(200, [{ name: 'a', fields: ['x'] }]);
    vi.stubGlobal('fetch', fetchMock);
    expect(await listUserSecrets()).toEqual([{ name: 'a', fields: ['x'] }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://adapter/secrets');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('puts the fields as the body to the named route', async () => {
    const fetchMock = respond(200, { name: 'model_server', fields: ['api_key'] });
    vi.stubGlobal('fetch', fetchMock);
    await saveUserSecret('model_server', { api_key: 'k' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://adapter/secrets/model_server');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ fields: { api_key: 'k' } });
  });

  it('deletes by name', async () => {
    const fetchMock = respond(200);
    vi.stubGlobal('fetch', fetchMock);
    await deleteUserSecret('a');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://adapter/secrets/a');
    expect(init.method).toBe('DELETE');
  });

  it.each([
    [401, 'TAPIS_AUTH_REQUIRED', /sign-in has expired/i],
    [503, 'SECRETS_NOT_CONFIGURED', /not available/i],
    [409, 'SECRET_LOCKED_BY_RUN', /run in progress.*finished/i],
    [429, 'SECRET_RATE_LIMITED', /too many times/i],
    [404, 'SECRET_NOT_FOUND', /no longer exists/i],
    [422, 'SECRET_INVALID', /not accepted/i],
  ])('maps %s %s to a sentence', async (status, code, pattern) => {
    vi.stubGlobal('fetch', respond(status, { detail: { code, message: 'SENTINEL-secret-value' } }));
    const error = await saveUserSecret('a', { f: 'SENTINEL-secret-value' }).catch((e) => e);
    expect(error).toBeInstanceOf(UserSecretError);
    expect(error.message).toMatch(pattern);
    expect(error.message).not.toContain('SENTINEL');
  });

  it('never repeats a value from a validation body', async () => {
    vi.stubGlobal('fetch', respond(422, { detail: [{ msg: 'bad', input: 'SENTINEL' }] }));
    const error = await saveUserSecret('a', { f: 'SENTINEL' }).catch((e) => e);
    expect(error.message).not.toContain('SENTINEL');
  });

  it('says so when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom SENTINEL')));
    const error = await listUserSecrets().catch((e) => e);
    expect(error.message).not.toContain('SENTINEL');
    expect(error.message).toMatch(/could not be reached/i);
  });
});

describe('validateUserSecret', () => {
  const ok = [{ name: 'api_key', value: 'v' }];
  it('accepts a valid credential', () => expect(validateUserSecret('model_server', ok)).toBeNull());
  it('refuses a bad name', () => expect(validateUserSecret('Bad Name', ok)).toMatch(/name/i));
  it('refuses no fields', () => expect(validateUserSecret('a', [])).toMatch(/at least one/i));
  it('refuses a bad field name', () =>
    expect(validateUserSecret('a', [{ name: 'API-Key', value: 'v' }])).toMatch(/field names/i));
  it('refuses a duplicate field', () =>
    expect(validateUserSecret('a', [...ok, ...ok])).toMatch(/only once/i));
  it('refuses an empty value', () =>
    expect(validateUserSecret('a', [{ name: 'k', value: '' }])).toMatch(/enter a value/i));
  it('refuses too many fields', () =>
    expect(
      validateUserSecret(
        'a',
        Array.from({ length: 17 }, (_, i) => ({ name: `f${i}`, value: 'v' })),
      ),
    ).toMatch(/at most 16/));
  it('refuses more than 4096 bytes', () =>
    expect(validateUserSecret('a', [{ name: 'k', value: 'x'.repeat(4096) }])).toMatch(/4096/));
});
