/**
 * A flow run that stopped for its user's edit: what it shows, who may continue it,
 * and the upload that stands in for the file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';

import { EnsembleManagerError, type UnifiedRunSnapshot } from '@/lib/ensemble-manager';

const upload = vi.hoisted(() => ({
  uploadFilesToCatalog: vi.fn(),
  listUploadOrganizations: vi.fn(),
}));
vi.mock('@/lib/ckan-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ckan-upload')>()),
  uploadFilesToCatalog: upload.uploadFilesToCatalog,
  listUploadOrganizations: upload.listUploadOrganizations,
}));

import { PausedFlowStep } from '../PausedFlowStep';
import { FlowRunPanel } from '../FlowRunPanel';
import { EditedInputNote } from '../EditedInputNote';

const EDIT_URL = 'https://ckan.example.org/dataset/ds-1/resource/res-9/download/lexicon.json';
const LEXICON = 'tapis://ls6/scratch/alice/out/lexicon_draft.json';

function pausedRun(over: Partial<UnifiedRunSnapshot> = {}): UnifiedRunSnapshot {
  return {
    run_id: 'ue_flow-1',
    status: 'awaiting_edit',
    adapter_stage: 'flow',
    execution_mode: 'workflow_pipeline',
    model_child_id: 'exec-1',
    started_by: 'alice',
    pause: {
      output_key: '1:1',
      file: 'lexicon_draft.json',
      file_location: LEXICON,
      paused_after_step: 1,
      paused_at: '2026-11-20T10:00:00+00:00',
      error: null,
    },
    workflow_stages: [
      {
        stage_id: 'step-1',
        type: 'flow_step',
        name: 'Draft the lexicon',
        depends_on: [],
        status: 'completed',
        provider: 'tapis-workflows',
        provider_ids: {},
      },
      {
        stage_id: 'step-2',
        type: 'flow_step',
        name: 'Score the lexicon',
        depends_on: ['step-1'],
        status: 'waiting',
        provider: 'tapis-workflows',
        provider_ids: {},
      },
    ],
    ...over,
  };
}

const UPLOADED = {
  notes: [],
  datasetId: 'ds-1',
  datasetName: 'Uploaded files',
  resources: [{ id: 'res-9', name: 'lexicon.json', url: EDIT_URL, selected: true }],
};

beforeEach(() => {
  vi.clearAllMocks();
  upload.listUploadOrganizations.mockResolvedValue([{ id: 'org-1', name: 'o', title: 'Org One' }]);
  upload.uploadFilesToCatalog.mockResolvedValue(UPLOADED);
});

async function uploadEdit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Upload the edited file' }));
  await waitFor(() => expect(screen.getByLabelText('Organisation')).toBeEnabled());
  await user.selectOptions(screen.getByLabelText('Organisation'), 'org-1');
  await user.upload(
    screen.getByTestId('upload-file-input'),
    new File(['{}'], 'lexicon.json', { type: 'application/json' }),
  );
  await user.click(screen.getByRole('button', { name: 'Upload 1 file' }));
  await screen.findByTestId('flow-paused-edit');
}

describe('PausedFlowStep', () => {
  it('shows the paused step and the file to edit, with a download', () => {
    render(
      <PausedFlowStep
        run={pausedRun()}
        ensembleManagerApi="https://em"
        username="alice"
        stepName="Draft the lexicon"
      />,
    );
    expect(screen.getByTestId('flow-paused')).toHaveTextContent(
      'Paused after “Draft the lexicon”: review and edit lexicon_draft.json',
    );
    expect(screen.getByTestId('flow-paused-file')).toHaveTextContent('lexicon_draft.json');
    expect(screen.getByTestId('download-paused-file')).toBeInTheDocument();
  });

  it('shows nothing for a run that is not paused', () => {
    const { container } = render(
      <PausedFlowStep
        run={pausedRun({ pause: null })}
        ensembleManagerApi="https://em"
        username="alice"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('uploads the edit privately as a file that belongs to no input, then resumes with its catalog address', async () => {
    const user = userEvent.setup();
    const onResume = vi.fn().mockResolvedValue(undefined);
    render(
      <PausedFlowStep
        run={pausedRun()}
        ensembleManagerApi="https://em"
        username="alice"
        onResume={onResume}
      />,
    );
    expect(screen.getByTestId('resume-flow')).toBeDisabled();
    await uploadEdit(user);

    const params = upload.uploadFilesToCatalog.mock.calls[0]![0];
    expect(params).toMatchObject({
      organizationId: 'org-1',
      isPublic: false,
      multiple: false,
      variableOptional: true,
      variables: [],
      username: 'alice',
    });
    expect(params.files).toHaveLength(1);
    expect(screen.queryByText('Make these files public')).not.toBeInTheDocument();

    expect(screen.getByTestId('resume-flow')).toBeEnabled();
    await user.click(screen.getByTestId('resume-flow'));
    expect(onResume).toHaveBeenCalledWith({
      url: EDIT_URL,
      dataset_id: 'ds-1',
      resource_id: 'res-9',
    });
  });

  it('gives Resume and the upload to the user who started the run, and only to them', () => {
    render(
      <PausedFlowStep
        run={pausedRun()}
        ensembleManagerApi="https://em"
        username="mallory"
        onResume={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('resume-flow')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Upload the edited file' }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('flow-paused-not-yours')).toHaveTextContent('Only alice');
    // Everyone still sees the file.
    expect(screen.getByTestId('download-paused-file')).toBeInTheDocument();
  });

  it('shows nobody the controls when it is not known who started the run', () => {
    render(
      <PausedFlowStep
        run={pausedRun({ started_by: undefined })}
        ensembleManagerApi="https://em"
        username="alice"
        onResume={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('resume-flow')).not.toBeInTheDocument();
  });

  it('says why a refused edit was refused, and keeps the run waiting', async () => {
    const user = userEvent.setup();
    const onResume = vi
      .fn()
      .mockRejectedValue(
        new EnsembleManagerError(422, 'must be in the catalog', 'FLOW_REPLACEMENT_REFUSED'),
      );
    render(
      <PausedFlowStep
        run={pausedRun()}
        ensembleManagerApi="https://em"
        username="alice"
        onResume={onResume}
      />,
    );
    await uploadEdit(user);
    await user.click(screen.getByTestId('resume-flow'));
    const problem = await screen.findByTestId('flow-paused-problem');
    expect(problem).toHaveTextContent('The edited file was refused');
    expect(screen.getByTestId('resume-flow')).toBeEnabled();
  });

  it('asks for the edit again when the run says it is no longer waiting', async () => {
    const user = userEvent.setup();
    const onResume = vi
      .fn()
      .mockRejectedValue(new EnsembleManagerError(409, 'no', 'FLOW_NOT_AWAITING_EDIT'));
    render(
      <PausedFlowStep
        run={pausedRun()}
        ensembleManagerApi="https://em"
        username="alice"
        onResume={onResume}
      />,
    );
    await uploadEdit(user);
    await user.click(screen.getByTestId('resume-flow'));
    await screen.findByText('This run is not waiting for an edit');
    expect(screen.getByTestId('resume-flow')).toBeDisabled();
  });

  it('shows why the last edit could not be used, so another can be sent', () => {
    const run = pausedRun();
    run.pause!.error = 'lexicon.json cannot be used: no groups were found';
    render(
      <PausedFlowStep
        run={run}
        ensembleManagerApi="https://em"
        username="alice"
        onResume={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('no groups were found');
    expect(screen.getByRole('button', { name: 'Upload the edited file' })).toBeInTheDocument();
  });
});

describe('FlowRunPanel for a paused run', () => {
  it('shows the paused step, the steps still waiting, and Cancel in its own words', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(
      <FlowRunPanel
        run={pausedRun()}
        ensembleManagerApi="https://em"
        username="alice"
        onCancel={onCancel}
        onResume={vi.fn()}
      />,
    );
    expect(screen.getByTestId('flow-paused')).toHaveTextContent('Paused after “Draft the lexicon”');
    expect(screen.getByTestId('flow-node-step-2')).toHaveTextContent('Waiting');
    await user.click(screen.getByTestId('cancel-workflow'));
    expect(screen.getByText(/It stops here and cannot be continued/)).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-cancel-workflow'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('does not show the paused box for a run that is going or done', () => {
    render(<FlowRunPanel run={pausedRun({ status: 'adapter_running', pause: null })} />);
    expect(screen.queryByTestId('flow-paused')).not.toBeInTheDocument();
  });

  it('says that the run used an edited lexicon, by whom, when, and the hash it fetched', () => {
    render(
      <FlowRunPanel
        run={pausedRun({
          status: 'completed',
          pause: null,
          replacement: {
            output: '1:1',
            file: 'lexicon_draft.json',
            check: 'lexicon',
            dataset_id: 'ds-1',
            replaced_by: 'alice',
            replaced_at: '2026-11-20T11:00:00+00:00',
            sha256: 'b'.repeat(64),
            bytes: 412,
          },
        })}
      />,
    );
    const note = screen.getByTestId('edited-input-note');
    expect(note).toHaveTextContent('This result used an edited lexicon.');
    expect(note).toHaveTextContent('Edited by alice on 2026-11-20 11:00 UTC');
    expect(note).toHaveTextContent('ds-1');
    expect(note).toHaveTextContent('bbbbbbbbbbbb');
    expect(note).toHaveTextContent('412 bytes');
  });
});

describe('EditedInputNote', () => {
  it('calls a file that is not a lexicon a file', () => {
    const { unmount } = render(<EditedInputNote replacement={{ output: '1:1', check: 'json' }} />);
    expect(screen.getByTestId('edited-input-note')).toHaveTextContent(
      'This result used an edited file.',
    );
    unmount();
    render(<EditedInputNote replacement={{ output: '1:1' }} />);
    expect(screen.getByTestId('edited-input-note')).toHaveTextContent(
      'This result used an edited file.',
    );
  });
});
