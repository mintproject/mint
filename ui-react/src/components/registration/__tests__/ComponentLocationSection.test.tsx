import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormProvider, useForm } from 'react-hook-form';

import { renderWithProviders } from '@/test/utils/render';
import { setMintConfig } from '@/test/utils/mint-config';
import { Form } from '@/components/ui/form';
import { ComponentLocationSection } from '@/components/registration/ComponentLocationSection';
import { emptyCreateModel, type CreateModelSchema } from '@/schemas/registration';

const APP_LIST = [
  { tenant: 'portals', id: 'hello-world-fileinput-test', version: '0.0.5' },
  { tenant: 'portals', id: 'other-app', version: '1.0.0' },
];

const APP_DETAIL = {
  tenant: 'portals',
  id: 'hello-world-fileinput-test',
  version: '0.0.5',
  jobAttributes: {
    fileInputs: [
      { name: 'Required Input', description: 'must provide', inputMode: 'REQUIRED' },
      { name: 'Optional Input', description: 'may omit', inputMode: 'OPTIONAL' },
      { name: 'Fixed Input', description: 'locked', inputMode: 'FIXED' },
    ],
    parameterSet: {
      appArgs: [
        { name: 'Greeting', description: 'a greeting', inputMode: 'REQUIRED', arg: 'hello' },
      ],
    },
  },
};

function tapisDeployment() {
  setMintConfig({
    AUTH_PROVIDER: 'tapis',
    AUTH_SERVER: 'https://portals.tapis.io',
    EXECUTION_ENGINE: 'tapis',
  });
  localStorage.setItem('mint.access_token', 'tok-123');
}

function mockApi() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    // The list is `/v3/apps?listType=...`; one app is `/v3/apps/{id}/{version}`.
    const isList = /\/v3\/apps\?/.test(url);
    const body = { result: isList ? APP_LIST : APP_DETAIL };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

/** Exposes the form values the section writes, so a test can assert on them. */
function Harness({ onValues }: { onValues?: (v: CreateModelSchema) => void }) {
  const form = useForm<CreateModelSchema>({ defaultValues: emptyCreateModel() });
  onValues?.(form.watch());
  return (
    <FormProvider {...form}>
      <Form {...form}>
        <ComponentLocationSection />
        <output data-testid="value">{form.watch('componentLocation')}</output>
        <output data-testid="inputs">
          {(form.watch('inputs') ?? []).map((i) => i.label).join('|')}
        </output>
        <output data-testid="optional">
          {(form.watch('inputs') ?? []).map((i) => String(i.isOptional)).join('|')}
        </output>
        <output data-testid="parameters">
          {(form.watch('parameters') ?? []).map((p) => `${p.label}=${p.hasDefaultValue}`).join('|')}
        </output>
      </Form>
    </FormProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('ComponentLocationSection', () => {
  it('stores the canonical app URL when the user picks a Tapis application', async () => {
    tapisDeployment();
    mockApi();
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const trigger = await screen.findByRole('combobox', { name: /choose a tapis application/i });
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    await user.click(await screen.findByText('hello-world-fileinput-test'));

    await waitFor(() =>
      expect(screen.getByTestId('value')).toHaveTextContent(
        'https://portals.tapis.io/v3/apps/hello-world-fileinput-test/0.0.5',
      ),
    );
  });

  it('fills inputs and parameters from the application, skipping a FIXED input', async () => {
    tapisDeployment();
    mockApi();
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const trigger = await screen.findByRole('combobox', { name: /choose a tapis application/i });
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    await user.click(await screen.findByText('hello-world-fileinput-test'));

    await user.click(await screen.findByRole('button', { name: /fill inputs and parameters/i }));

    await waitFor(() =>
      expect(screen.getByTestId('inputs')).toHaveTextContent('Required Input|Optional Input'),
    );
    // A FIXED input is supplied by the app itself, so the model declares none.
    expect(screen.getByTestId('inputs')).not.toHaveTextContent('Fixed Input');
    expect(screen.getByTestId('optional')).toHaveTextContent('false|true');
    expect(screen.getByTestId('parameters')).toHaveTextContent('Greeting=hello');
  });

  it('offers a plain URL field on a deployment that does not run Tapis', async () => {
    setMintConfig({ AUTH_PROVIDER: 'keycloak', EXECUTION_ENGINE: 'localex' });
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    expect(
      screen.queryByRole('combobox', { name: /choose a tapis application/i }),
    ).not.toBeInTheDocument();

    const field = screen.getByRole('textbox');
    await user.type(field, 'https://example.org/components/model.zip');
    await waitFor(() =>
      expect(screen.getByTestId('value')).toHaveTextContent(
        'https://example.org/components/model.zip',
      ),
    );
  });

  it('lets a Tapis deployment type any URL instead', async () => {
    tapisDeployment();
    mockApi();
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.click(await screen.findByRole('tab', { name: /any url/i }));

    const field = screen.getByRole('textbox');
    await user.type(field, 'https://example.org/components/model.zip');
    await waitFor(() =>
      expect(screen.getByTestId('value')).toHaveTextContent(
        'https://example.org/components/model.zip',
      ),
    );
  });

  it('reports a failed app listing and keeps the manual route open', async () => {
    tapisDeployment();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    renderWithProviders(<Harness />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/503/);
    expect(screen.getByRole('tab', { name: /any url/i })).toBeInTheDocument();
  });
});
