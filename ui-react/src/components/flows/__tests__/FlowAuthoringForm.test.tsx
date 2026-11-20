import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { draftFromStoredFlow, emptyDraft, type StoredFlowSource } from '@/lib/flow-authoring';
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
  { id: 'piece-c', label: 'Count' },
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
  'piece-c': {
    inputs: [1],
    outputs: [1],
    settings: ['match_mode', 'max_files'],
    values: [],
    input_contracts: { '1': { standard_variable_uri: 'https://x.org/corpus' } },
    output_contracts: { '1': {} },
    setting_details: {
      match_mode: {
        type: 'string',
        title: 'How terms are counted',
        description: 'The counting rule.',
        default: 'auto',
        choices: [
          { value: 'auto', title: 'Automatic', description: 'Words and phrases.' },
          { value: 'longest', title: 'Longest match', description: 'No double counting.' },
        ],
      },
      max_files: { type: 'integer', title: 'Most files', minimum: 1, maximum: 500, advanced: true },
    },
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
    expect(within(step).getByLabelText('top n')).toBeInTheDocument();
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

    await user.type(within(screen.getByTestId('flow-form-step-1')).getByLabelText('top n'), '5');
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

  describe('settings described by their piece', () => {
    const counting = () => ({
      ...emptyDraft(),
      software: { id: '', label: 'Sensemaking' },
      version: { id: '', label: '1' },
      configuration: { label: 'My flow', description: '' },
      inputs: [
        {
          key: 'input1',
          label: 'Docs',
          standardVariable: 'sv:corpus',
          standardVariableLabel: 'Corpus',
          format: '',
          optional: false,
        },
      ],
      steps: [
        {
          pieceId: 'piece-c',
          settings: {},
          wires: [{ to: { input: 1 }, from: { flow_input: 'input1' } }],
          pauseAfter: false,
        },
      ],
    });

    it('shows titles, a dropdown with explanations and a bounded number box', async () => {
      fakeServer();
      const user = userEvent.setup();
      render({ initial: counting() });
      const step = await screen.findByTestId('flow-form-step-1');
      const mode = await within(step).findByLabelText('How terms are counted');
      expect(mode.tagName).toBe('SELECT');
      await user.selectOptions(mode, 'Longest match');
      expect(within(step).getByText('No double counting.')).toBeInTheDocument();
      const files = within(step).getByLabelText('Most files');
      expect(files).toHaveAttribute('type', 'number');
      expect(files).toHaveAttribute('max', '500');
      // The piece suggests this one is advanced, and the author may change that.
      expect(within(step).getByLabelText('Who sees Most files')).toHaveValue('advanced');
      expect(within(step).getByLabelText('Who sees How terms are counted')).toHaveValue('shown');
    });

    it('saves the value, whether it is fixed and who sees it, in the check and the save', async () => {
      fakeServer();
      const user = userEvent.setup();
      render({ initial: counting() });
      const step = await screen.findByTestId('flow-form-step-1');
      await user.selectOptions(
        await within(step).findByLabelText('How terms are counted'),
        'Longest match',
      );
      await user.selectOptions(
        within(step).getByLabelText('Is the value of How terms are counted a default or fixed'),
        'fixed',
      );
      await user.selectOptions(
        within(step).getByLabelText('Who sees How terms are counted'),
        'hidden',
      );
      const save = screen.getByRole('button', { name: 'Save flow' });
      await waitFor(() => expect(save).toBeEnabled());
      await user.click(save);
      await waitFor(() =>
        expect(calls.some((c) => c.url === 'http://catalog.test/v2.0.0/flows')).toBe(true),
      );
      const sent = calls.find((c) => c.url === 'http://catalog.test/v2.0.0/flows')!;
      expect(sent.body.steps[0].settings).toEqual({ match_mode: 'longest' });
      expect(sent.body.settings).toEqual({ match_mode: { fixed: true, visibility: 'hidden' } });
      const check = [...calls].reverse().find((c) => c.url.endsWith('/flows/check'))!;
      expect(check.body.settings).toEqual({ match_mode: { fixed: true, visibility: 'hidden' } });
    });

    it('says that hidden is not secret, once a setting is hidden', async () => {
      fakeServer();
      const user = userEvent.setup();
      render({ initial: counting() });
      const step = await screen.findByTestId('flow-form-step-1');
      expect(within(step).queryByText(/not shown, not secret/)).not.toBeInTheDocument();
      await user.selectOptions(
        await within(step).findByLabelText('Who sees How terms are counted'),
        'hidden',
      );
      expect(within(step).getByText(/not shown, not secret/)).toBeInTheDocument();
    });

    it('sends no decisions when the author made none', async () => {
      fakeServer();
      render({ initial: counting() });
      await screen.findByTestId('flow-form-step-1');
      await waitFor(() => expect(calls.some((c) => c.url.endsWith('/flows/check'))).toBe(true));
      expect(calls.find((c) => c.url.endsWith('/flows/check'))!.body.settings).toEqual({});
    });

    it('leaves out a decision about a setting no step has any more', async () => {
      fakeServer();
      const draft = { ...counting(), settings: { gone: { visibility: 'hidden' as const } } };
      render({ initial: draft });
      await screen.findByLabelText('How terms are counted');
      await waitFor(() =>
        expect(calls.filter((c) => c.url.endsWith('/flows/check')).at(-1)?.body.settings).toEqual(
          {},
        ),
      );
    });
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

  describe('a pause that makes a file editable', () => {
    async function pausedFirstStep(user: ReturnType<typeof userEvent.setup>) {
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
      await user.click(screen.getByLabelText('Pause for review after this step'));
    }

    const lastCall = (suffix: string) => calls.filter((c) => c.url.endsWith(suffix)).at(-1)!.body;

    it('sends pause_after and the chosen editable output in the check and the save', async () => {
      const user = userEvent.setup();
      await pausedFirstStep(user);
      await user.selectOptions(screen.getByLabelText('Editable output of step 1'), '1');
      await user.type(screen.getByLabelText('File name to edit for step 1'), 'lexicon_draft.json');
      await user.selectOptions(
        screen.getByLabelText('Check on the edited file of step 1'),
        'lexicon',
      );
      await user.type(screen.getByLabelText('Key of the edited file of step 1'), 'lexicon_uri');

      const save = screen.getByRole('button', { name: 'Save flow' });
      await waitFor(() => expect(save).toBeEnabled());
      const editable = { file: 'lexicon_draft.json', check: 'lexicon', key: 'lexicon_uri' };
      const checkBody = lastCall('/flows/check');
      expect(checkBody.steps[0].pause_after).toBe(true);
      expect(checkBody.outputs).toEqual([{ step: 1, output: 1, editable }]);

      await user.click(save);
      await waitFor(() => expect(calls.some((c) => c.url.endsWith('/v2.0.0/flows'))).toBe(true));
      const sent = calls.find((c) => c.url.endsWith('/v2.0.0/flows'))!.body;
      expect(sent.steps[0].pause_after).toBe(true);
      expect(sent.outputs).toEqual([expect.objectContaining({ step: 1, output: 1, editable })]);
    });

    it('leaves out a blank check and key', async () => {
      const user = userEvent.setup();
      await pausedFirstStep(user);
      await user.selectOptions(screen.getByLabelText('Editable output of step 1'), '1');
      await user.type(screen.getByLabelText('File name to edit for step 1'), 'a.json');
      await waitFor(() =>
        expect(lastCall('/flows/check').outputs[0].editable).toEqual({ file: 'a.json' }),
      );
    });

    it('blocks saving a paused step with no editable output, and says why', async () => {
      const user = userEvent.setup();
      await pausedFirstStep(user);
      const step = screen.getByTestId('flow-form-step-1');
      expect(
        await within(step).findByText(/Choose the file output the person edits/),
      ).toBeVisible();
      await waitFor(() =>
        expect(screen.getByText('The flow fits its pieces.')).toBeInTheDocument(),
      );
      expect(screen.getByRole('button', { name: 'Save flow' })).toBeDisabled();

      await user.selectOptions(screen.getByLabelText('Editable output of step 1'), '1');
      expect(await within(step).findByText(/Name the file to edit/)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Save flow' })).toBeDisabled();
    });

    it('drops the editable file when the pause is turned off', async () => {
      const user = userEvent.setup();
      await pausedFirstStep(user);
      await user.selectOptions(screen.getByLabelText('Editable output of step 1'), '1');
      await user.type(screen.getByLabelText('File name to edit for step 1'), 'a.json');
      await user.click(screen.getByLabelText('Pause for review after this step'));
      expect(screen.queryByLabelText('Editable output of step 1')).toBeNull();
      await waitFor(() => expect(lastCall('/flows/check').steps[0].pause_after).toBe(false));
      expect(lastCall('/flows/check').outputs).toEqual([{ step: 1, output: 1 }]);
    });
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

    it('pre-fills the editable choice of a paused flow', async () => {
      const editable = { file: 'lexicon_draft.json', check: 'lexicon', key: 'lexicon_uri' };
      render({
        initial: draftFromStoredFlow({
          ...stored,
          flow: {
            ...stored.flow,
            outputs_json: [{ step: 1, output: 1, output_id: 'cfg_output_1', editable }],
            steps: [{ ...stored.flow.steps[0]!, pause_after: true }],
          },
        }),
      });
      expect(screen.getByLabelText('Pause for review after this step')).toBeChecked();
      expect(await screen.findByLabelText('Editable output of step 1')).toHaveValue('1');
      expect(screen.getByLabelText('File name to edit for step 1')).toHaveValue(
        'lexicon_draft.json',
      );
      expect(screen.getByLabelText('Check on the edited file of step 1')).toHaveValue('lexicon');
      expect(screen.getByLabelText('Key of the edited file of step 1')).toHaveValue('lexicon_uri');
      const save = screen.getByRole('button', { name: 'Save flow' });
      await waitFor(() => expect(save).toBeEnabled());
    });

    it('is prefilled and saves a NEW configuration under the same version, thread bindings included', async () => {
      const user = userEvent.setup();
      render({ initial: draftFromStoredFlow(stored) });
      expect(screen.getByLabelText('Flow name')).toHaveValue('Dictionary (copy)');
      expect(
        screen.getByText(/Saved as a new configuration under the same version of Sense/),
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Input 1 takes a collection of files')).toBeChecked();
      expect(screen.getByLabelText('Region is filled in by')).toHaveValue('input:Corpus');
      expect(await screen.findByLabelText('top n')).toHaveValue('25');

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

describe('FlowAuthoringForm semantic recommendations', () => {
  type Reply = { status: number; json: unknown };
  let semantic: (url: string, body: Call['body']) => Reply;
  let proposeFor: (uri: string | undefined) => unknown;

  const PIECE_HIT = {
    id: 'piece-a',
    label: 'Ingest',
    description: 'Reads a corpus and cleans it',
    score: 0.9,
    ranking_source: 'semantic',
    visibility: 'public',
    owner_username: 'someone',
    inputs: [{ position: 1, standard_variable_uri: 'https://x.org/corpus', label: 'Corpus' }],
    outputs: [{ position: 1, standard_variable_uri: 'https://x.org/clean', label: 'Clean text' }],
  };

  const emptyProposal = {
    direct: [],
    chains: [],
    next: [],
    produces: [],
    cut: false,
    warnings: [],
  };

  beforeEach(() => {
    semantic = () => ({ status: 200, json: { results: [] } });
    proposeFor = () => emptyProposal;
    const adapter = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const reply = (r: Reply) =>
          ({ ok: r.status < 400, status: r.status, json: async () => r.json }) as Response;
        if (url.includes('/search?') || url.includes('/similar?')) {
          return reply(semantic(url, undefined));
        }
        if (url.endsWith('/flows/propose')) {
          const body = JSON.parse(String(init.body));
          calls.push({ url, body });
          return reply({
            status: 200,
            json: proposeFor(body.purpose?.contract?.standard_variable_uri),
          });
        }
        return adapter(url, init);
      }),
    );
  });

  const pickWanted = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'Pick a variable' }));
  const find = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'Find pieces that make it' }));

  it('searches pieces by description, lists their variables, and adds one as a step', async () => {
    semantic = (url) =>
      url.includes('target=etl_piece') && url.includes('lexicon')
        ? { status: 200, json: { results: [PIECE_HIT] } }
        : { status: 200, json: { results: [] } };
    const user = userEvent.setup();
    render();
    await user.type(
      screen.getByLabelText('Describe what this step should do'),
      'count lexicon terms',
    );
    const hit = await screen.findByText('Reads a corpus and cleans it');
    const item = hit.closest('li')!;
    expect(item).toHaveTextContent('Takes: Corpus');
    expect(item).toHaveTextContent('Returns: Clean text');
    await user.click(within(item).getByRole('button', { name: 'Add Ingest as a step' }));
    expect(await screen.findByTestId('flow-form-step-1')).toBeInTheDocument();
  });

  it('also finds the user private pieces the service does not list', async () => {
    const user = userEvent.setup();
    render({
      pieces: [
        ...PIECES,
        { id: 'mine', label: 'Lexicon counter', visibility: 'private', description: 'my own' },
      ],
    });
    await user.type(
      screen.getByLabelText('Describe what this step should do'),
      'count lexicon terms',
    );
    const list = await screen.findByRole('list', { name: 'Pieces that match the description' });
    expect(within(list).getByText('Lexicon counter')).toBeInTheDocument();
    expect(list).toHaveTextContent('private, yours');
  });

  it('shows close variables, marked not exact, when nothing makes the wanted one', async () => {
    semantic = (url) =>
      url.includes('/similar?')
        ? {
            status: 200,
            json: {
              target: 'svo',
              id: 'sv:corpus',
              results: [
                { id: 'sv:corpus', label: 'Corpus' },
                { id: 'sv:near', label: 'Near corpus' },
              ],
            },
          }
        : { status: 200, json: { results: [] } };
    proposeFor = (uri) =>
      uri === 'sv:near'
        ? {
            ...emptyProposal,
            produces: [
              {
                piece: 'piece-b',
                label: 'Score',
                output: 1,
                complete: true,
                approval: 'builtin',
                inputs: [],
              },
            ],
          }
        : emptyProposal;
    const user = userEvent.setup();
    render();
    await pickWanted(user);
    await find(user);
    const box = await screen.findByTestId('close-variables');
    expect(box).toHaveTextContent('No piece makes Corpus exactly. These make close variables:');
    expect(box).toHaveTextContent('Near corpus');
    expect(box).toHaveTextContent('close, not an exact match');
    // At most three extra propose calls, and none for the wanted variable twice.
    const close = calls.filter(
      (c) =>
        c.url.endsWith('/flows/propose') &&
        c.body.purpose.contract.standard_variable_uri !== 'sv:corpus',
    );
    expect(close.length).toBeLessThanOrEqual(3);
    await user.click(within(box).getByRole('button', { name: 'Add Score for Near corpus' }));
    expect(await screen.findByTestId('flow-form-step-1')).toBeInTheDocument();
  });

  const BUDGET = 'https://w3id.org/okn/i/mint/drain__budget';
  const routeNeed = (extra: object = {}) => ({
    input: 1,
    met: false,
    direct: [],
    chains: [],
    variable: BUDGET,
    variable_label: 'Drain budget',
    format: 'csv',
    ...extra,
  });
  const routeProposal = () => ({
    ...emptyProposal,
    produces: [
      {
        piece: 'piece-a',
        label: 'Ingest',
        output: 1,
        complete: false,
        approval: 'builtin',
        output_variable: 'https://x.org/clean',
        output_label: 'Clean text',
        output_format: 'csv',
        converter: false,
        inputs: [
          routeNeed({
            providers: {
              models: [
                {
                  configuration_id: 'https://w3id.org/okn/i/mint/model-9',
                  label: 'Crawler',
                  output: 1,
                  format: 'csv',
                  variable: BUDGET,
                  output_label: 'Drain budget',
                },
              ],
              datasets: [
                { data_object_id: 'ds-1', label: BUDGET, name: 'Hearings corpus', format: 'csv' },
                { data_object_id: 'ds-1', label: BUDGET, name: 'Hearings corpus', format: 'csv' },
              ],
            },
          }),
        ],
      },
      {
        piece: 'piece-b',
        label: 'Score',
        output: 1,
        complete: false,
        converter: true,
        output_variable: BUDGET,
        inputs: [routeNeed()],
      },
    ],
  });

  it('groups routes, names inputs and datasets, and adds a model route in one click', async () => {
    proposeFor = routeProposal;
    const user = userEvent.setup();
    render();
    await pickWanted(user);
    await find(user);
    const routes = await screen.findByTestId('routes');
    expect(within(routes).getByText('From a model')).toBeInTheDocument();
    expect(routes).toHaveTextContent('needs: Drain budget (csv)');
    expect(routes).not.toHaveTextContent('input 1:');
    // The converter with nothing to convert is under a collapsed heading.
    expect(within(routes).getByTestId('route-group-converters')).toHaveTextContent(
      'Unit conversions (1)',
    );
    const advice = within(routes).getAllByTestId('need-providers')[0]!;
    expect(advice).toHaveTextContent(
      "Run Crawler in a thread, then use its Drain budget as this flow's input",
    );
    expect(within(advice).getByRole('link', { name: 'Crawler' })).toHaveAttribute(
      'href',
      '/modelconfigurations/model-9',
    );
    // A dataset is named, not its variable URI, and listed once.
    expect(
      within(advice).getAllByRole('button', { name: /from dataset Hearings corpus/ }),
    ).toHaveLength(1);
    expect(advice).not.toHaveTextContent('w3id.org');
    await user.click(
      within(advice).getByRole('button', { name: 'Add this route: Ingest from model Crawler' }),
    );
    expect(screen.getByLabelText('Input 1 label')).toHaveValue('Drain budget');
    expect(await screen.findByTestId('flow-form-step-1')).toBeInTheDocument();
  });

  it('adds a dataset route as a flow input named for the dataset', async () => {
    proposeFor = routeProposal;
    const user = userEvent.setup();
    render();
    await pickWanted(user);
    await find(user);
    await user.click(
      await screen.findByRole('button', {
        name: 'Add this route: Ingest from dataset Hearings corpus',
      }),
    );
    expect(screen.getByLabelText('Input 1 label')).toHaveValue('Hearings corpus');
    expect(await screen.findByTestId('flow-form-step-1')).toBeInTheDocument();
  });

  it('describes a format-only input readably and adds its route, bound by format', async () => {
    proposeFor = () => ({
      ...emptyProposal,
      produces: [
        {
          piece: 'piece-a',
          label: 'Modflow6 drain extract',
          output: 1,
          complete: false,
          converter: false,
          output_variable: 'sv:flow',
          output_label: 'Spring — volume flow rate',
          output_format: 'gma-scalar',
          inputs: [
            routeNeed({
              variable: null,
              variable_label: null,
              format: 'cbc-mf6',
              providers: {
                models: [
                  {
                    configuration_id: 'https://w3id.org/okn/i/mint/mf6',
                    label: 'MODFLOW 6',
                    output: 1,
                    format: 'cbc-mf6',
                    variable: null,
                    output_label: null,
                  },
                ],
                datasets: [],
              },
            }),
          ],
        },
        {
          piece: 'piece-b',
          label: 'Cfs to m3s',
          output: 1,
          complete: false,
          converter: true,
          output_variable: 'sv:flow',
          output_label: 'Spring — volume flow rate',
          inputs: [
            routeNeed({
              variable: 'sv:flow',
              variable_label: 'Spring — volume flow rate',
              providers: {
                models: [],
                datasets: [{ data_object_id: 'd', name: 'Flow data', format: 'csv' }],
              },
            }),
          ],
        },
      ],
    });
    const user = userEvent.setup();
    render();
    await pickWanted(user);
    await find(user);
    const routes = await screen.findByTestId('routes');
    expect(routes).toHaveTextContent('needs: MODFLOW 6 cell-by-cell budget (cbc-mf6)');
    expect(routes).toHaveTextContent(
      "then use its MODFLOW 6 cell-by-cell budget as this flow's input",
    );
    expect(routes).not.toHaveTextContent('input 0');
    expect(
      within(routes).getByRole('region', {
        name: 'Convert Spring — volume flow rate data you already have (e.g. Cfs to m3s)',
      }),
    ).toBeInTheDocument();
    await user.click(
      within(routes).getByRole('button', {
        name: 'Add this route: Modflow6 drain extract from model MODFLOW 6',
      }),
    );
    expect(screen.getByLabelText('Input 1 label')).toHaveValue('MODFLOW 6 cell-by-cell budget');
    expect(await screen.findByTestId('flow-form-step-1')).toBeInTheDocument();
  });

  it('hides the suggestions quietly when the semantic service is down', async () => {
    semantic = () => ({ status: 503, json: { error: 'down' } });
    const user = userEvent.setup();
    render();
    await user.type(
      screen.getByLabelText('Describe what this step should do'),
      'count lexicon terms',
    );
    expect(await screen.findByText(/unavailable right now/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Pieces that match the description')).toBeNull();
    await pickWanted(user);
    await find(user);
    await screen.findByText('Nothing in the catalog fits.');
    expect(screen.queryByTestId('close-variables')).toBeNull();
    // The step picker still works.
    await addStepOf(user, 'Ingest');
    expect(await screen.findByTestId('flow-form-step-1')).toBeInTheDocument();
  });
});
