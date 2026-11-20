import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { draftFromStoredFlow, type StoredFlowSource } from '@/lib/flow-authoring';
import { renderWithProviders, screen, waitFor, within } from '@/test/utils/render';
import { setMintConfig } from '@/test/utils/mint-config';

import { FlowAuthoringForm } from '../FlowAuthoringForm';

vi.mock('@/components/autocomplete/StandardVariableCombobox', () => ({
  StandardVariableCombobox: ({
    value,
    onChange,
  }: {
    value: { label: string } | null;
    onChange: (option: { id: string; label: string; description: null } | null) => void;
  }) => (
    <button
      type="button"
      onClick={() => onChange({ id: 'sv:corpus', label: 'Corpus', description: null })}
    >
      {value ? `Variable: ${value.label}` : 'Pick a variable'}
    </button>
  ),
}));

const PIECES = [
  { id: 'piece-a', label: 'Ingest' },
  { id: 'piece-b', label: 'Score' },
];
const SUMMARIES = {
  'piece-a': {
    inputs: [1],
    outputs: [1],
    settings: ['top_n'],
    values: [],
    input_contracts: { '1': { standard_variable_uri: 'https://x.org/corpus', format: 'csv' } },
    output_contracts: { '1': { standard_variable_uri: 'https://x.org/clean' } },
    setting_details: { top_n: { type: 'string', default: '10' } },
  },
  'piece-b': {
    inputs: [1],
    outputs: [1],
    settings: [],
    values: [],
    input_contracts: { '1': { standard_variable_uri: 'https://x.org/clean' } },
    output_contracts: { '1': {} },
    setting_details: {},
  },
};

type Wire = { to: { input?: number }; from: Record<string, unknown> };
type Step = { position: number; wires: Wire[] };
type Problem = { code: string; message: string; step: number; wire?: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Call = { url: string; body: any };
let calls: Call[];

/** A stand-in for the adapter's check and propose routes, and for POST /flows. */
function fakeServer(options: { saveStatus?: number } = {}) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      const reply = (status: number, json: unknown) =>
        ({ ok: status < 400, status, json: async () => json }) as Response;
      if (url.endsWith('/flows/check')) {
        const problems: Problem[] = [];
        for (const step of body.steps as Step[]) {
          const wire = step.wires.findIndex((w) => w.to.input === 1);
          if (wire < 0) {
            problems.push({
              code: 'FLOW_INPUT_UNWIRED',
              message: `input 1 of step ${step.position} is not linked`,
              step: step.position,
            });
          } else if (step.position === 2 && 'flow_input' in step.wires[wire]!.from) {
            problems.push({
              code: 'FLOW_WIRE_DOES_NOT_FIT',
              message: 'does not fit the input: standard variable differs',
              step: 2,
              wire,
            });
          }
        }
        return reply(200, {
          ok: problems.length === 0,
          problems,
          depends_on: {},
          pieces: SUMMARIES,
        });
      }
      if (url.endsWith('/flows/propose')) {
        return reply(200, {
          purpose: body.purpose,
          direct: [
            {
              source: { kind: 'step_output', step: 1, output: 1 },
              fits: true,
              wire: { to: { input: 1 }, from: { step: 1, output: 1 } },
            },
          ],
          chains: [],
          next: [{ piece: 'piece-b', label: 'Score', approval: 'builtin', input: 1 }],
          produces: [],
          cut: false,
          warnings: [],
        });
      }
      if (url.endsWith('/flows')) {
        return options.saveStatus && options.saveStatus >= 400
          ? reply(options.saveStatus, {
              error: 'the flow does not fit its pieces',
              code: 'FLOW_DOES_NOT_CHECK_OUT',
              problems: [{ code: 'X', message: 'nothing fits', step: 1 }],
            })
          : reply(201, { configuration_id: 'https://w3id.org/okn/i/mint/new-flow' });
      }
      return reply(404, {});
    }),
  );
}

const render = (props: Partial<React.ComponentProps<typeof FlowAuthoringForm>> = {}) =>
  renderWithProviders(
    <FlowAuthoringForm pieces={PIECES} token="tok" checkDelayMs={0} {...props} />,
  );

async function addStepOf(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.selectOptions(screen.getByLabelText('Piece for the next step'), label);
  await user.click(screen.getByRole('button', { name: 'Add step' }));
}

async function fillAbout(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Flow name'), 'My flow');
  await user.type(screen.getByLabelText('Model name'), 'Sensemaking');
  await user.type(screen.getByLabelText('Version'), '1');
}

beforeEach(() => {
  setMintConfig({
    ENSEMBLE_MANAGER_API: 'http://em.test/v1',
    MODEL_CATALOG_API: 'http://catalog.test/v2.0.0',
  });
  fakeServer();
});
afterEach(() => vi.unstubAllGlobals());

describe('FlowAuthoringForm', () => {
  it('adds a step, shows the slots of its piece, and keeps Save off while the check fails', async () => {
    const user = userEvent.setup();
    render();
    await addStepOf(user, 'Ingest');
    const step = screen.getByTestId('flow-form-step-1');
    expect(await within(step).findByLabelText('Source of input 1 of step 1')).toBeInTheDocument();
    expect(within(step).getByLabelText('top_n')).toBeInTheDocument();
    expect(await within(step).findByText('input 1 of step 1 is not linked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save flow' })).toBeDisabled();
  });

  it('shows a check problem on the step and link it names, and not on the others', async () => {
    const user = userEvent.setup();
    render();
    await user.click(screen.getByRole('button', { name: 'Add a flow input' }));
    await addStepOf(user, 'Ingest');
    await addStepOf(user, 'Score');
    await user.selectOptions(
      await screen.findByLabelText('Source of input 1 of step 2'),
      'Flow input: input1',
    );
    const second = screen.getByTestId('flow-form-step-2');
    expect(await within(second).findByText(/standard variable differs/)).toBeInTheDocument();
    expect(
      within(screen.getByTestId('flow-form-step-1')).queryByText(/standard variable differs/),
    ).toBeNull();
  });

  it('links an input to an earlier output through a proposal, then saves with the right body', async () => {
    const user = userEvent.setup();
    render();
    await fillAbout(user);
    await user.click(screen.getByRole('button', { name: 'Add a flow input' }));
    await user.click(
      within(screen.getByTestId('flow-form-input-0')).getByRole('button', {
        name: 'Pick a variable',
      }),
    );
    await addStepOf(user, 'Ingest');
    await user.selectOptions(
      await screen.findByLabelText('Source of input 1 of step 1'),
      'Flow input: input1',
    );
    await addStepOf(user, 'Score');
    await user.click(
      await screen.findByRole('button', { name: 'Suggest sources for step 2 input 1' }),
    );
    await user.click(
      await screen.findByRole('button', { name: /Use step 1 \(Ingest\), output 1/ }),
    );
    expect(screen.getByLabelText('Source of input 1 of step 2')).toHaveValue('step:1:1');

    const proposal = calls.find((c) => c.url.endsWith('/flows/propose'))!;
    expect(proposal.url).toBe('http://em.test/v1/adapter/flows/propose');
    expect(proposal.body.purpose).toEqual({ step: 2, input: 1 });

    await user.type(within(screen.getByTestId('flow-form-step-1')).getByLabelText('top_n'), '5');
    const save = screen.getByRole('button', { name: 'Save flow' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);

    await waitFor(() =>
      expect(calls.some((c) => c.url === 'http://catalog.test/v2.0.0/flows')).toBe(true),
    );
    const sent = calls.find((c) => c.url === 'http://catalog.test/v2.0.0/flows')!;
    expect(sent.body).toMatchObject({
      software: { label: 'Sensemaking' },
      version: { label: '1' },
      configuration: { label: 'My flow' },
      inputs: [{ key: 'input1', standard_variable: 'sv:corpus', optional: false }],
      steps: [
        {
          position: 1,
          etl_process_id: 'piece-a',
          settings: { top_n: '5' },
          wires: [{ to: { input: 1 }, from: { flow_input: 'input1' } }],
        },
        {
          position: 2,
          etl_process_id: 'piece-b',
          wires: [{ to: { input: 1 }, from: { step: 1, output: 1 } }],
        },
      ],
    });
    expect(await screen.findByRole('link', { name: 'Open the new flow' })).toHaveAttribute(
      'href',
      '/modelconfigurations/new-flow',
    );
  });

  it('adds a proposed next step wired from the output it was asked about', async () => {
    const user = userEvent.setup();
    render();
    await user.click(screen.getByRole('button', { name: 'Add a flow input' }));
    await addStepOf(user, 'Ingest');
    await user.click(
      await screen.findByRole('button', { name: 'Suggest next steps from step 1 output 1' }),
    );
    await user.click(await screen.findByRole('button', { name: /Add Score \(input 1\)/ }));
    expect(await screen.findByLabelText('Source of input 1 of step 2')).toHaveValue('step:1:1');
  });

  it('shows the problems a refused save returns', async () => {
    fakeServer({ saveStatus: 422 });
    const user = userEvent.setup();
    render({
      initial: draftFromStoredFlow({
        configuration: {
          label: 'Flow',
          software_version: { id: 'ver-1', version_id: '1', software: { id: 'sw-1', label: 'S' } },
          inputs: [],
          outputs: [],
          parameters: [],
        },
        flow: {
          steps: [
            {
              position: 1,
              etl_process_id: 'piece-b',
              wires_json: [{ to: { input: 1 }, from: { flow_input: 'x' } }],
            },
          ],
        },
      }),
    });
    const save = screen.getByRole('button', { name: 'Save flow' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    expect(await screen.findByText('the flow does not fit its pieces')).toBeInTheDocument();
    expect(screen.getByText(/nothing fits/)).toBeInTheDocument();
  });

  describe('edited as a copy', () => {
    const stored: StoredFlowSource = {
      configuration: {
        label: 'Dictionary',
        description: 'old',
        software_version: {
          id: 'ver-1',
          version_id: '1.0',
          software: { id: 'sw-1', label: 'Sense' },
        },
        inputs: [
          {
            input: {
              id: 'cfg_input_1',
              label: 'Corpus',
              has_format: 'csv',
              position: 1,
              presentations: [
                { presentation: { standard_variable: { id: 'sv:corpus', label: 'Corpus' } } },
              ],
            },
          },
        ],
        outputs: [{ output: { id: 'cfg_output_1', label: 'Report', has_format: 'html' } }],
        parameters: [],
      },
      flow: {
        thread_bindings_json: { region: { input: 'cfg_input_1' }, collections: ['cfg_input_1'] },
        outputs_json: [{ step: 1, output: 1, output_id: 'cfg_output_1' }],
        steps: [
          {
            position: 1,
            etl_process_id: 'piece-a',
            settings_json: { top_n: '25' },
            wires_json: [{ to: { input: 1 }, from: { flow_input: 'cfg_input_1' } }],
          },
        ],
      },
    };

    it('is prefilled and saves a NEW configuration under the same version, thread bindings included', async () => {
      const user = userEvent.setup();
      render({ initial: draftFromStoredFlow(stored) });
      expect(screen.getByLabelText('Flow name')).toHaveValue('Dictionary (copy)');
      expect(
        screen.getByText(/Saved as a new configuration under the same version of Sense/),
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Input 1 takes a collection of files')).toBeChecked();
      expect(screen.getByLabelText('Region is filled in by')).toHaveValue('input:Corpus');
      expect(await screen.findByLabelText('top_n')).toHaveValue('25');

      const save = screen.getByRole('button', { name: 'Save flow' });
      await waitFor(() => expect(save).toBeEnabled());
      await user.click(save);
      await waitFor(() => expect(calls.some((c) => c.url.endsWith('/v2.0.0/flows'))).toBe(true));
      const sent = calls.find((c) => c.url.endsWith('/v2.0.0/flows'))!.body;
      expect(sent.software).toEqual({ id: 'sw-1', label: 'Sense' });
      expect(sent.version).toEqual({ id: 'ver-1', label: '1.0' });
      expect(sent.configuration.label).toBe('Dictionary (copy)');
      expect(sent.thread_bindings).toEqual({
        region: { input: 'Corpus' },
        collections: ['Corpus'],
      });
      expect(sent.outputs).toEqual([{ step: 1, output: 1, label: 'Report', format: 'html' }]);
      // Nothing in the form deletes the old flow.
      expect(calls.every((c) => !/delete/i.test(c.url))).toBe(true);
    });
  });

  it('sets thread bindings, including collections, and sends them to the check', async () => {
    const user = userEvent.setup();
    render();
    await user.click(screen.getByRole('button', { name: 'Add a flow input' }));
    await addStepOf(user, 'Ingest');
    await user.selectOptions(screen.getByLabelText('Region is filled in by'), 'Flow input: input1');
    await user.click(screen.getByLabelText('Input 1 takes a collection of files'));
    await waitFor(() => {
      const last = [...calls].reverse().find((c) => c.url.endsWith('/flows/check'))!;
      expect(last.body.thread_bindings).toEqual({
        region: { input: 'input1' },
        collections: ['input1'],
      });
    });
  });
});
