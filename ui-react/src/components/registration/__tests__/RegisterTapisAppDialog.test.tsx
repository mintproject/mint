import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormProvider, useForm } from 'react-hook-form';

import { renderWithProviders } from '@/test/utils/render';
import { setMintConfig } from '@/test/utils/mint-config';
import { Form } from '@/components/ui/form';
import { ComponentLocationSection } from '@/components/registration/ComponentLocationSection';
import { emptyCreateModel, type CreateModelSchema } from '@/schemas/registration';

// Shaped like the Tapis command template's app.json.
const DEFINITION = {
  id: 'my-model',
  version: '0.1.0',
  description: 'A model',
  owner: '${apiUserId}',
  containerImage: 'docker://ghcr.io/me/my-model:0.1.0',
  jobAttributes: {
    execSystemId: 'ls6',
    maxMinutes: 10,
    fileInputs: [{ name: 'Dataset File', description: 'data', inputMode: 'REQUIRED' }],
    parameterSet: {
      appArgs: [{ name: 'Greeting', description: 'say hi', inputMode: 'REQUIRED', arg: 'hello' }],
    },
  },
};

const CREATED_URL = 'https://portals.tapis.io/v3/apps/my-model/0.1.0';

interface Call {
  method: string;
  url: string;
}

interface Behaviour {
  createStatus?: number;
  shareStatus?: number;
  readStatus?: number;
}

/** A Tapis stand-in. Records every call so a test can assert on order and content. */
function mockTapis(calls: Call[], behaviour: Behaviour = {}) {
  const { createStatus = 201, shareStatus = 200, readStatus = 200 } = behaviour;
  const respond = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (method === 'POST' && url.endsWith('/v3/apps')) {
      return createStatus === 201
        ? respond({ result: { url: CREATED_URL } }, 201)
        : respond({ status: 'error', message: 'APPLIC_APP_EXISTS my-model 0.1.0' }, createStatus);
    }
    if (method === 'POST' && url.includes('/share_public/')) {
      return shareStatus === 200
        ? respond({})
        : respond({ status: 'error', message: 'Not authorized to share' }, shareStatus);
    }
    if (/\/v3\/apps\?/.test(url)) {
      return respond({ result: [{ id: 'other-app', version: '1.0.0' }] });
    }
    if (url.endsWith('/v3/apps/my-model/0.1.0')) {
      return readStatus === 200
        ? respond({ result: { ...DEFINITION, id: 'my-model', version: '0.1.0' } })
        : respond({ status: 'error', message: 'not found' }, readStatus);
    }
    return respond({}, 404);
  });
}

function Harness({ withRows = false }: { withRows?: boolean }) {
  const form = useForm<CreateModelSchema>({
    defaultValues: withRows
      ? {
          ...emptyCreateModel(),
          inputs: [{ ...emptyCreateModel().inputs[0]!, label: 'My own input' }],
        }
      : emptyCreateModel(),
  });
  return (
    <FormProvider {...form}>
      <Form {...form}>
        <ComponentLocationSection />
        <output data-testid="value">{form.watch('componentLocation')}</output>
        <output data-testid="inputs">
          {(form.watch('inputs') ?? []).map((i) => i.label).join('|')}
        </output>
        <output data-testid="parameters">
          {(form.watch('parameters') ?? []).map((p) => p.label).join('|')}
        </output>
      </Form>
    </FormProvider>
  );
}

function tapisDeployment() {
  setMintConfig({
    AUTH_PROVIDER: 'tapis',
    AUTH_SERVER: 'https://portals.tapis.io',
    EXECUTION_ENGINE: 'tapis',
  });
  localStorage.setItem('mint.access_token', 'tok-123');
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /register a new application/i }));
  return screen.findByRole('dialog');
}

async function paste(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, text: string) {
  const box = within(dialog).getByLabelText(/or paste it here/i);
  await user.click(box);
  // Typing JSON through userEvent mangles braces, so paste it.
  await user.paste(text);
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('RegisterTapisAppDialog', () => {
  it('is offered in Tapis mode only', async () => {
    tapisDeployment();
    mockTapis([]);
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    expect(
      await screen.findByRole('button', { name: /register a new application/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /any url/i }));
    expect(
      screen.queryByRole('button', { name: /register a new application/i }),
    ).not.toBeInTheDocument();
  });

  it('is not offered on a deployment that does not run Tapis', () => {
    setMintConfig({ AUTH_PROVIDER: 'keycloak', EXECUTION_ENGINE: 'localex' });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    renderWithProviders(<Harness />);

    expect(
      screen.queryByRole('button', { name: /register a new application/i }),
    ).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks Review on invalid JSON and explains why', async () => {
    tapisDeployment();
    mockTapis([]);
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const dialog = await openDialog(user);

    await paste(user, dialog, '{ not json');

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/not valid JSON/i);
    expect(within(dialog).getByRole('button', { name: /^review$/i })).toBeDisabled();
  });

  it('shows what will be created, and sends nothing before Create', async () => {
    tapisDeployment();
    const calls: Call[] = [];
    mockTapis(calls);
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const dialog = await openDialog(user);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const before = calls.length;

    await paste(user, dialog, JSON.stringify(DEFINITION));
    await user.click(within(dialog).getByRole('button', { name: /^review$/i }));

    expect(await within(dialog).findByText('my-model')).toBeInTheDocument();
    expect(within(dialog).getByText(/docker:\/\/ghcr.io\/me\/my-model:0.1.0/)).toBeInTheDocument();
    expect(within(dialog).getByText('ls6')).toBeInTheDocument();
    expect(within(dialog).getByText(/Dataset File/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Greeting/)).toBeInTheDocument();
    expect(within(dialog).getByText(/makes it public/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot edit or remove it/i)).toBeInTheDocument();
    // Opening, pasting and reviewing wrote nothing.
    expect(calls.slice(before).filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('flags an id and version that already appear in the list', async () => {
    tapisDeployment();
    mockTapis([]);
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const dialog = await openDialog(user);

    await paste(user, dialog, JSON.stringify({ ...DEFINITION, id: 'other-app', version: '1.0.0' }));
    await user.click(within(dialog).getByRole('button', { name: /^review$/i }));

    expect(await within(dialog).findByText(/already appears in your list/i)).toBeInTheDocument();
  });

  it('warns that environment variables will be public', async () => {
    tapisDeployment();
    mockTapis([]);
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const dialog = await openDialog(user);

    await paste(
      user,
      dialog,
      JSON.stringify({
        ...DEFINITION,
        jobAttributes: {
          ...DEFINITION.jobAttributes,
          parameterSet: { appArgs: [], envVariables: [{ key: 'K', value: 'V' }] },
        },
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: /^review$/i }));

    expect(await within(dialog).findByText(/environment variables/i)).toBeInTheDocument();
  });

  it('creates, then makes public, then selects the app and fills the form', async () => {
    tapisDeployment();
    const calls: Call[] = [];
    mockTapis(calls);
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const dialog = await openDialog(user);

    await paste(user, dialog, JSON.stringify(DEFINITION));
    await user.click(within(dialog).getByRole('button', { name: /^review$/i }));
    await user.click(await within(dialog).findByRole('button', { name: /create application/i }));

    expect(await within(dialog).findByText(/created my-model 0.1.0/i)).toBeInTheDocument();
    expect(await within(dialog).findByText(/it is public/i)).toBeInTheDocument();

    // Order: create, then share, then read back for the seed.
    const writes = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(writes).toEqual([
      'https://portals.tapis.io/v3/apps',
      'https://portals.tapis.io/v3/apps/share_public/my-model',
    ]);
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent(CREATED_URL));
    await waitFor(() => expect(screen.getByTestId('inputs')).toHaveTextContent('Dataset File'));
    expect(screen.getByTestId('parameters')).toHaveTextContent('Greeting');
    // The list was read again after the create, so the new app can be listed.
    expect(calls.filter((c) => /\/v3\/apps\?/.test(c.url)).length).toBeGreaterThanOrEqual(2);
  });

  it('shows Tapis’s message and keeps the pasted text when create fails', async () => {
    tapisDeployment();
    const calls: Call[] = [];
    mockTapis(calls, { createStatus: 409 });
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const dialog = await openDialog(user);

    const text = JSON.stringify(DEFINITION);
    await paste(user, dialog, text);
    await user.click(within(dialog).getByRole('button', { name: /^review$/i }));
    await user.click(await within(dialog).findByRole('button', { name: /create application/i }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/409.*APPLIC_APP_EXISTS/);
    // Nothing was shared or selected, and the author can go back and fix it.
    expect(calls.some((c) => c.url.includes('share_public'))).toBe(false);
    expect(screen.getByTestId('value')).toHaveTextContent('');
    await user.click(within(dialog).getByRole('button', { name: /^back$/i }));
    expect(within(dialog).getByLabelText(/or paste it here/i)).toHaveValue(text);
  });

  it('keeps the app selected when sharing fails, and retries only the share', async () => {
    tapisDeployment();
    const calls: Call[] = [];
    mockTapis(calls, { shareStatus: 403 });
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const dialog = await openDialog(user);

    await paste(user, dialog, JSON.stringify(DEFINITION));
    await user.click(within(dialog).getByRole('button', { name: /^review$/i }));
    await user.click(await within(dialog).findByRole('button', { name: /create application/i }));

    expect(await within(dialog).findByText(/could not be made public/i)).toBeInTheDocument();
    // The create is never reported as a failure, and the app is selected.
    expect(within(dialog).getByText(/created my-model 0.1.0/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent(CREATED_URL));

    const createsBefore = calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('/v3/apps'),
    ).length;
    await user.click(within(dialog).getByRole('button', { name: /make public/i }));
    await waitFor(() => expect(calls.filter((c) => c.url.includes('share_public')).length).toBe(2));
    // Retrying never creates the app a second time.
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v3/apps')).length).toBe(
      createsBefore,
    );
  });

  it('does not report a failed create when the read-back fails', async () => {
    tapisDeployment();
    mockTapis([], { readStatus: 404 });
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const dialog = await openDialog(user);

    await paste(user, dialog, JSON.stringify(DEFINITION));
    await user.click(within(dialog).getByRole('button', { name: /^review$/i }));
    await user.click(await within(dialog).findByRole('button', { name: /create application/i }));

    expect(await within(dialog).findByText(/could not be read back/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/created my-model 0.1.0/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent(CREATED_URL));
  });

  it('asks before replacing rows the author already has — Keep leaves them', async () => {
    tapisDeployment();
    mockTapis([]);
    const user = userEvent.setup();
    renderWithProviders(<Harness withRows />);
    const dialog = await openDialog(user);

    await paste(user, dialog, JSON.stringify(DEFINITION));
    await user.click(within(dialog).getByRole('button', { name: /^review$/i }));
    await user.click(await within(dialog).findByRole('button', { name: /create application/i }));

    expect(await within(dialog).findByText(/replace them/i)).toBeInTheDocument();
    // Not replaced yet.
    expect(screen.getByTestId('inputs')).toHaveTextContent('My own input');

    await user.click(within(dialog).getByRole('button', { name: /keep my rows/i }));
    expect(screen.getByTestId('inputs')).toHaveTextContent('My own input');
    expect(screen.getByTestId('inputs')).not.toHaveTextContent('Dataset File');
  });

  it('replaces the rows when the author chooses Replace', async () => {
    tapisDeployment();
    mockTapis([]);
    const user = userEvent.setup();
    renderWithProviders(<Harness withRows />);
    const dialog = await openDialog(user);

    await paste(user, dialog, JSON.stringify(DEFINITION));
    await user.click(within(dialog).getByRole('button', { name: /^review$/i }));
    await user.click(await within(dialog).findByRole('button', { name: /create application/i }));
    await user.click(await within(dialog).findByRole('button', { name: /^replace$/i }));

    await waitFor(() => expect(screen.getByTestId('inputs')).toHaveTextContent('Dataset File'));
    expect(screen.getByTestId('inputs')).not.toHaveTextContent('My own input');
  });

  it('sends nothing when the dialog is cancelled', async () => {
    tapisDeployment();
    const calls: Call[] = [];
    mockTapis(calls);
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const dialog = await openDialog(user);
    await paste(user, dialog, JSON.stringify(DEFINITION));
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});
