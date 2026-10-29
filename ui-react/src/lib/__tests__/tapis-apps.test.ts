import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_APP_DEFINITION_BYTES,
  buildSeedFromTapisApp,
  buildTapisAppUrl,
  createTapisApp,
  getTapisApp,
  getTapisTenant,
  listTapisApps,
  parseTapisAppDefinition,
  parseTapisAppUrl,
  shareTapisAppPublic,
  usesTapisComponents,
  type TapisApp,
} from '@/lib/tapis-apps';
import { setMintConfig } from '@/test/utils/mint-config';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('parseTapisAppUrl / buildTapisAppUrl', () => {
  it('round-trips a canonical app URL', () => {
    const url = 'https://portals.tapis.io/v3/apps/hello-world-fileinput-test/0.0.5';
    const ref = parseTapisAppUrl(url);
    expect(ref).toEqual({
      tenant: 'portals',
      id: 'hello-world-fileinput-test',
      version: '0.0.5',
    });
    expect(buildTapisAppUrl(ref!)).toBe(url);
  });

  it('rejects the sharing endpoint, which carries no id and no version', () => {
    // https://portals.tapis.io/v3/apps/share/<id> answers {publicShare: true}.
    // The Ensemble Manager needs both the id and the version, so this URL must
    // never reach has_component_location.
    expect(parseTapisAppUrl('https://portals.tapis.io/v3/apps/share/hello-world')).toBeNull();
  });

  it('rejects a non-Tapis URL', () => {
    expect(parseTapisAppUrl('https://example.org/components/model.zip')).toBeNull();
    expect(parseTapisAppUrl('')).toBeNull();
  });
});

describe('getTapisTenant', () => {
  it('reads the tenant from the Tapis auth server', () => {
    setMintConfig({ AUTH_PROVIDER: 'tapis', AUTH_SERVER: 'https://portals.tapis.io' });
    expect(getTapisTenant()).toBe('portals');
  });

  it('returns null for a Keycloak deployment', () => {
    setMintConfig({ AUTH_PROVIDER: 'keycloak', AUTH_SERVER: 'https://auth.example.org' });
    expect(getTapisTenant()).toBeNull();
  });

  it('returns null when the auth server is not a Tapis host', () => {
    setMintConfig({ AUTH_PROVIDER: 'tapis', AUTH_SERVER: 'https://auth.example.org' });
    expect(getTapisTenant()).toBeNull();
  });
});

describe('usesTapisComponents', () => {
  it('is true only when the deployment runs Tapis and a tenant is known', () => {
    setMintConfig({
      AUTH_PROVIDER: 'tapis',
      AUTH_SERVER: 'https://portals.tapis.io',
      EXECUTION_ENGINE: 'tapis',
    });
    expect(usesTapisComponents()).toBe(true);

    setMintConfig({
      AUTH_PROVIDER: 'tapis',
      AUTH_SERVER: 'https://portals.tapis.io',
      EXECUTION_ENGINE: 'localex',
    });
    expect(usesTapisComponents()).toBe(false);

    setMintConfig({ AUTH_PROVIDER: 'keycloak', EXECUTION_ENGINE: 'tapis' });
    expect(usesTapisComponents()).toBe(false);
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function signedIn() {
  localStorage.setItem('mint.access_token', 'tok-123');
}

describe('listTapisApps', () => {
  it('reads every visible app straight from Tapis with the user token', async () => {
    signedIn();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ result: [{ id: 'hello', version: '0.0.5' }] }));

    const apps = await listTapisApps('portals');

    expect(apps).toEqual([{ tenant: 'portals', id: 'hello', version: '0.0.5' }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    // ALL, so an app made public by someone else is listed; limit=-1, because
    // Tapis otherwise stops at 100 and drops the rest.
    expect(url).toBe('https://portals.tapis.io/v3/apps?listType=ALL&limit=-1&select=id,version');
    expect((init?.headers as Record<string, string>)['X-Tapis-Token']).toBe('tok-123');
  });

  it('never sends the token to a host other than the tenant', async () => {
    signedIn();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ result: [] }));
    await listTapisApps('portals');
    expect(new URL(String(fetchMock.mock.calls[0]![0])).hostname).toBe('portals.tapis.io');
  });

  it('throws an error that names the status and the Tapis message', async () => {
    signedIn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ status: 'error', message: 'JWT expired' }, 401),
    );
    await expect(listTapisApps('portals')).rejects.toThrow(/401.*JWT expired/);
  });

  it('falls back to the status when the error body is not JSON', async () => {
    signedIn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    await expect(listTapisApps('portals')).rejects.toThrow(/503/);
  });

  it('refuses to call without a token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(listTapisApps('portals')).rejects.toThrow(/sign in/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops an entry with no id or no version', async () => {
    signedIn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ result: [{ id: 'hello', version: '0.0.5' }, { id: 'broken' }] }),
    );
    await expect(listTapisApps('portals')).resolves.toHaveLength(1);
  });
});

describe('getTapisApp', () => {
  it('reads one app, encoding the id and version into the path', async () => {
    signedIn();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ result: { jobAttributes: { fileInputs: [] } } }));

    const app = await getTapisApp({ tenant: 'portals', id: 'a b', version: '1/2' });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://portals.tapis.io/v3/apps/a%20b/1%2F2',
    );
    expect(app).toMatchObject({ tenant: 'portals', id: 'a b', jobAttributes: { fileInputs: [] } });
  });
});

describe('createTapisApp', () => {
  it('posts the definition with the token and returns the reference Tapis reports', async () => {
    signedIn();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        json({ result: { url: 'https://portals.tapis.io/v3/apps/my-model/0.1.0' } }, 201),
      );
    const definition = { id: 'my-model', version: '0.1.0', containerImage: 'docker://x/y:1' };

    const ref = await createTapisApp('portals', definition);

    expect(ref).toEqual({ tenant: 'portals', id: 'my-model', version: '0.1.0' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://portals.tapis.io/v3/apps');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual(definition);
    expect((init?.headers as Record<string, string>)['X-Tapis-Token']).toBe('tok-123');
  });

  it('falls back to the posted id and version when Tapis returns no url', async () => {
    signedIn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}, 201));
    await expect(createTapisApp('portals', { id: 'my-model', version: '0.1.0' })).resolves.toEqual({
      tenant: 'portals',
      id: 'my-model',
      version: '0.1.0',
    });
  });

  it('surfaces the Tapis message when the app already exists', async () => {
    signedIn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ status: 'error', message: 'APPLIC_APP_EXISTS my-model 0.1.0' }, 409),
    );
    await expect(createTapisApp('portals', { id: 'my-model', version: '0.1.0' })).rejects.toThrow(
      /409.*APPLIC_APP_EXISTS/,
    );
  });
});

describe('shareTapisAppPublic', () => {
  it('posts to the public-share path for the id', async () => {
    signedIn();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}));
    await shareTapisAppPublic('portals', 'my model');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://portals.tapis.io/v3/apps/share_public/my%20model');
    expect(init?.method).toBe('POST');
  });

  it('treats an app that is already public as shared', async () => {
    signedIn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ status: 'error', message: 'App is already publicly shared' }, 400),
    );
    await expect(shareTapisAppPublic('portals', 'my-model')).resolves.toBeUndefined();
  });

  it('rethrows any other failure', async () => {
    signedIn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ status: 'error', message: 'Not authorized' }, 403),
    );
    await expect(shareTapisAppPublic('portals', 'my-model')).rejects.toThrow(/403/);
  });
});

describe('parseTapisAppDefinition', () => {
  // Shaped like the Tapis command template's app.json.
  const good = {
    id: 'no-interactive-example',
    version: '0.1.0',
    description: 'Run a script',
    owner: '${apiUserId}',
    enabled: true,
    containerImage: 'docker://ghcr.io/in-for-disaster-analytics/cookbook-docker-template:0.1.0',
    jobAttributes: {
      execSystemId: 'ls6',
      nodeCount: 1,
      coresPerNode: 1,
      memoryMB: 1000,
      maxMinutes: 10,
      fileInputs: [{ name: 'Dataset File', description: 'billing data', inputMode: 'REQUIRED' }],
      parameterSet: {
        appArgs: [{ name: 'Greeting', description: 'say hi', inputMode: 'REQUIRED', arg: 'hello' }],
        envVariables: [],
      },
    },
  };
  const parse = (def: unknown) => parseTapisAppDefinition(JSON.stringify(def));

  it('accepts the template and summarises what it creates', () => {
    const result = parse(good);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toMatchObject({
      id: 'no-interactive-example',
      version: '0.1.0',
      execSystemId: 'ls6',
      maxMinutes: 10,
      memoryMB: 1000,
      coresPerNode: 1,
    });
    expect(result.summary.inputs.map((i) => i.label)).toEqual(['Dataset File']);
    expect(result.summary.parameters.map((p) => p.label)).toEqual(['Greeting']);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['not JSON', '{ nope', /not valid JSON/],
    ['an array', '[]', /single JSON object/],
    ['a string', '"x"', /single JSON object/],
  ])('rejects %s', (_name, text, message) => {
    const result = parseTapisAppDefinition(text);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it.each([
    ['id', { ...good, id: undefined }, /"id"/],
    ['version', { ...good, version: '' }, /"version"/],
    ['containerImage', { ...good, containerImage: undefined }, /"containerImage"/],
    ['an id with a slash', { ...good, id: 'a/b' }, /cannot contain/],
    ['a version with a slash', { ...good, version: '1/2' }, /cannot contain/],
    ['the reserved id share', { ...good, id: 'share' }, /reserved/],
    ['an untagged image', { ...good, containerImage: 'docker://ghcr.io/x/y' }, /version tag/],
    ['a latest image', { ...good, containerImage: 'docker://ghcr.io/x/y:latest' }, /version tag/],
    ['a registry port but no tag', { ...good, containerImage: 'localhost:5000/y' }, /version tag/],
    ['isPublic', { ...good, isPublic: true }, /"isPublic"/],
    ['tenant', { ...good, tenant: 'other' }, /"tenant"/],
    ['deleted', { ...good, deleted: true }, /"deleted"/],
    ['another owner', { ...good, owner: 'someone-else' }, /"owner"/],
  ])('rejects %s', (_name, def, message) => {
    const result = parse(def);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it('accepts an image pinned by digest', () => {
    expect(parse({ ...good, containerImage: 'docker://ghcr.io/x/y@sha256:abc' }).ok).toBe(true);
  });

  it('accepts a definition with no owner', () => {
    const { owner: _owner, ...rest } = good;
    expect(parse(rest).ok).toBe(true);
  });

  it('rejects text over the size limit', () => {
    const result = parseTapisAppDefinition(
      JSON.stringify({ ...good, description: 'x'.repeat(MAX_APP_DEFINITION_BYTES) }),
    );
    expect(result).toMatchObject({ ok: false });
  });

  it('warns about an input or setting with no name, which DYNAMO cannot match', () => {
    const result = parse({
      ...good,
      jobAttributes: {
        ...good.jobAttributes,
        fileInputs: [{ description: 'nameless', inputMode: 'REQUIRED' }],
      },
    });
    expect(result.ok && result.warnings.join(' ')).toMatch(/no "name"/);
  });

  it('does not warn about an unnamed FIXED input, which DYNAMO never matches', () => {
    const result = parse({
      ...good,
      jobAttributes: {
        ...good.jobAttributes,
        fileInputs: [{ description: 'supplied by the app', inputMode: 'FIXED' }],
      },
    });
    expect(result.ok && result.warnings).toEqual([]);
    expect(result.ok && result.summary.inputs).toEqual([]);
  });

  it('warns that environment variables will be public', () => {
    const result = parse({
      ...good,
      jobAttributes: {
        ...good.jobAttributes,
        parameterSet: { appArgs: [], envVariables: [{ key: 'TOKEN', value: 'secret' }] },
      },
    });
    expect(result.ok && result.warnings.join(' ')).toMatch(/environment variables.*public/);
  });

  it('flags uncommon top-level fields without refusing them', () => {
    const result = parse({ ...good, surprise: 1 });
    expect(result.ok && result.warnings.join(' ')).toMatch(/surprise/);
  });
});

describe('buildSeedFromTapisApp', () => {
  // Trimmed from the real hello-world-fileinput-test 0.0.5 response.
  const app: TapisApp = {
    tenant: 'portals',
    id: 'hello-world-fileinput-test',
    version: '0.0.5',
    jobAttributes: {
      fileInputs: [
        {
          name: 'Required Input',
          description: 'User must provide sourceUrl at submission',
          inputMode: 'REQUIRED',
        },
        {
          name: 'Optional Input',
          description: 'User may omit at submission',
          inputMode: 'OPTIONAL',
        },
        {
          name: 'Fixed Input',
          description: 'Locked by app, user cannot override',
          inputMode: 'FIXED',
        },
      ],
      parameterSet: {
        appArgs: [
          {
            name: 'Greeting',
            description: 'Choose a greeting',
            inputMode: 'REQUIRED',
            arg: 'hello',
          },
          { name: 'Target', description: 'Whom to address', inputMode: 'REQUIRED', arg: 'world' },
          {
            name: 'Sleep Time',
            description: 'How long to sleep',
            inputMode: 'REQUIRED',
            arg: '1',
            notes: { fieldType: 'number' },
          },
        ],
      },
    },
  };

  it('takes one input per non-FIXED file input, keeping the Tapis name verbatim', () => {
    // TapisJobService.createJobFileInputsFromSeed matches the model input label
    // against fileInput.name, so the label must not be reworded.
    const seed = buildSeedFromTapisApp(app);
    expect(seed.inputs).toEqual([
      {
        label: 'Required Input',
        description: 'User must provide sourceUrl at submission',
        isOptional: false,
      },
      { label: 'Optional Input', description: 'User may omit at submission', isOptional: true },
    ]);
  });

  it('takes one parameter per app argument, with its default value', () => {
    const seed = buildSeedFromTapisApp(app);
    expect(seed.parameters).toEqual([
      {
        label: 'Greeting',
        description: 'Choose a greeting',
        hasDefaultValue: 'hello',
        hasDataType: 'string',
      },
      {
        label: 'Target',
        description: 'Whom to address',
        hasDefaultValue: 'world',
        hasDataType: 'string',
      },
      {
        label: 'Sleep Time',
        description: 'How long to sleep',
        hasDefaultValue: '1',
        hasDataType: 'float',
      },
    ]);
  });

  it('returns empty lists for an app that declares nothing', () => {
    expect(buildSeedFromTapisApp({ tenant: 't', id: 'a', version: '1' })).toEqual({
      inputs: [],
      parameters: [],
    });
  });
});
