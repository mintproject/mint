/**
 * Tests for MintProblemStatement — the adaptive right panel and the sub-task
 * status dots (P1-2).
 *
 * The right panel shows a problem-statement overview when nothing is selected,
 * and embeds the thread wizard inline when a sub-task is selected.
 */
import { describe, expect, it } from 'vitest';
import type { MockedResponse } from '@apollo/client/testing';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders, screen, within } from '@/test/utils/render';
import { LIST_TOP_REGIONS } from '@/graphql/queries/regions';
import {
  GetProblemStatementDocument,
  GetThreadDocument,
  GetModelTreeWithRegionsDocument,
} from '@/graphql/generated/modeling';
import { MintProblemStatement } from '../MintProblemStatement';

const ts = '2026-01-01T00:00:00+00:00';

const threadWithModel = {
  __typename: 'thread',
  id: 'th-model',
  name: 'Rainfed scenario',
  task_id: 't-1',
  start_date: '2000-01-01',
  end_date: '2020-01-01',
  region_id: 'south_sudan',
  driving_variable_id: 'v-precip',
  response_variable_id: 'v-yield',
  driving_variable: {
    __typename: 'modelcatalog_standard_variable',
    id: 'v-precip',
    label: 'precipitation',
  },
  response_variable: {
    __typename: 'modelcatalog_standard_variable',
    id: 'v-yield',
    label: 'crop yield',
  },
  events: [
    {
      __typename: 'thread_provenance',
      event: 'CREATE',
      timestamp: ts,
      userid: 'testuser',
      notes: null,
    },
  ],
  permissions: [],
  thread_models: [
    {
      __typename: 'thread_model',
      id: 'tm-1',
      thread_id: 'th-model',
      model_id: null,
      modelcatalog_configuration_id: 'cfg-1',
      modelcatalog_configuration: {
        __typename: 'modelcatalog_configuration',
        id: 'cfg-1',
        label: 'CYCLES',
      },
    },
  ],
};

const threadEmpty = {
  __typename: 'thread',
  id: 'th-empty',
  name: 'Irrigated scenario',
  task_id: 't-1',
  start_date: '2000-01-01',
  end_date: '2020-01-01',
  region_id: 'south_sudan',
  driving_variable_id: null,
  response_variable_id: null,
  driving_variable: null,
  response_variable: null,
  events: [
    {
      __typename: 'thread_provenance',
      event: 'CREATE',
      timestamp: ts,
      userid: 'testuser',
      notes: null,
    },
  ],
  permissions: [],
  thread_models: [],
};

const threadOther = {
  ...threadEmpty,
  id: 'th-other',
  name: 'Flood scenario',
  task_id: 't-2',
};

const problemStatement = {
  __typename: 'problem_statement',
  id: 'ps-1',
  name: 'Flood study',
  start_date: '2000-01-01',
  end_date: '2020-01-01',
  region_id: 'south_sudan',
  events: [
    {
      __typename: 'problem_statement_provenance',
      event: 'CREATE',
      timestamp: ts,
      userid: 'testuser',
      notes: null,
    },
  ],
  permissions: [],
  tasks: [
    {
      __typename: 'task',
      id: 't-1',
      name: 'Crop modeling',
      problem_statement_id: 'ps-1',
      start_date: '2000-01-01',
      end_date: '2020-01-01',
      region_id: 'south_sudan',
      driving_variable_id: null,
      response_variable_id: null,
      events: [
        {
          __typename: 'task_provenance',
          event: 'CREATE',
          timestamp: ts,
          userid: 'testuser',
          notes: null,
        },
      ],
      permissions: [],
      threads: [threadWithModel, threadEmpty],
    },
  ],
};

/** Two tasks with sub-tasks plus a third task that has none. */
const multiTaskStatement = {
  ...problemStatement,
  tasks: [
    ...problemStatement.tasks,
    {
      ...problemStatement.tasks[0],
      id: 't-2',
      name: 'Water modeling',
      events: [{ ...problemStatement.tasks[0]!.events[0], timestamp: '2025-01-01T00:00:00+00:00' }],
      threads: [threadOther],
    },
    {
      ...problemStatement.tasks[0],
      id: 't-3',
      name: 'Bare task',
      events: [{ ...problemStatement.tasks[0]!.events[0], timestamp: '2024-01-01T00:00:00+00:00' }],
      threads: [],
    },
  ],
};

function mocks(ps: unknown = problemStatement): MockedResponse[] {
  return [
    {
      request: { query: GetProblemStatementDocument, variables: { id: 'ps-1' } },
      result: { data: { problem_statement_by_pk: ps } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    },
    // Used only when a sub-task is selected (the inline wizard loads the thread).
    {
      request: { query: GetThreadDocument, variables: { id: 'th-model' } },
      result: { data: { thread_by_pk: threadWithModel } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    },
    {
      request: { query: GetThreadDocument, variables: { id: 'th-other' } },
      result: { data: { thread_by_pk: threadOther } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    },
    {
      request: { query: GetModelTreeWithRegionsDocument },
      result: { data: { modelcatalog_software: [] } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    },
    {
      request: { query: LIST_TOP_REGIONS },
      result: { data: { region: [] } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    },
  ];
}

function renderPage(ps: unknown = problemStatement, search = '') {
  return renderWithProviders(
    <Routes>
      <Route path="/modeling/problem-statement/:id" element={<MintProblemStatement />} />
    </Routes>,
    {
      apolloMocks: mocks(ps),
      initialEntries: [`/modeling/problem-statement/ps-1${search}`],
    },
  );
}

describe('MintProblemStatement detail panel', () => {
  it('shows the problem overview when no sub-task is selected', async () => {
    renderPage();

    expect(await screen.findByText('Recent activity')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Sub-tasks')).toBeInTheDocument();
    expect(screen.getByText(/empty/)).toBeInTheDocument();
  });

  it('renders emerald/amber status dots per sub-task model state', async () => {
    renderPage();

    const tree = await screen.findByRole('tree');
    await userEvent.click(within(tree).getByText('Crop modeling'));

    expect(await screen.findByLabelText('Model selected')).toBeInTheDocument();
    expect(screen.getByLabelText('No model yet')).toBeInTheDocument();
  });

  it('embeds the thread wizard inline when a sub-task is selected', async () => {
    renderPage();

    const tree = await screen.findByRole('tree');
    await userEvent.click(within(tree).getByText('Crop modeling'));
    await userEvent.click(within(tree).getByText('Rainfed scenario'));

    // The wizard mounts inline (no full-page navigation) on its first step.
    expect(await screen.findByTestId('mint-thread')).toBeInTheDocument();
    expect(
      await screen.findByPlaceholderText('Describe the goal of this sub-task'),
    ).toBeInTheDocument();
    const stepRail = screen.getByRole('complementary', { name: 'Sub-task step navigation' });
    expect(within(stepRail).getByTestId('subtask-steps-toggle')).toBeInTheDocument();
  });
});

describe('MintProblemStatement per-task sub-task lists', () => {
  // The overview panel also names sub-tasks, so scope lookups to the task tree.
  const tree = () => screen.getByRole('tree', { name: 'Tasks' });
  const inTree = (name: string) => within(tree()).queryByText(name);
  const toggleFor = (name: string) =>
    screen.getByRole('button', { name: `Toggle sub-tasks of ${name}` });

  it('lists the sub-tasks of every task, not just the selected one', async () => {
    renderPage(multiTaskStatement);

    expect(
      await within(await screen.findByRole('tree')).findByText('Rainfed scenario'),
    ).toBeInTheDocument();
    expect(inTree('Irrigated scenario')).toBeInTheDocument();
    expect(inTree('Flood scenario')).toBeInTheDocument();
    // A task without sub-tasks says so and still offers the create action.
    expect(screen.getByText('No sub-tasks yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Create new sub-task' })).toHaveLength(3);
  });

  it('collapses and expands a task list via the chevron, with aria-expanded', async () => {
    renderPage(multiTaskStatement);
    await within(await screen.findByRole('tree')).findByText('Flood scenario');

    const toggle = toggleFor('Water modeling');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls');

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(inTree('Flood scenario')).not.toBeInTheDocument();
    // Other tasks are untouched, and toggling does not select the task.
    expect(inTree('Rainfed scenario')).toBeInTheDocument();
    expect(screen.queryByTestId('mint-thread')).not.toBeInTheDocument();
    expect(screen.getByText('Recent activity')).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await within(tree()).findByText('Flood scenario')).toBeInTheDocument();
  });

  it('is keyboard operable', async () => {
    renderPage(multiTaskStatement);
    await within(await screen.findByRole('tree')).findByText('Flood scenario');

    const toggle = toggleFor('Water modeling');
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('selects the task and opens the sub-task when picked under a non-selected task', async () => {
    renderPage(multiTaskStatement);

    await userEvent.click(
      await within(await screen.findByRole('tree')).findByText('Flood scenario'),
    );

    expect(await screen.findByTestId('mint-thread')).toBeInTheDocument();
    const tree = screen.getByRole('tree', { name: 'Tasks' });
    const taskItem = within(tree).getByText('Water modeling').closest('[role="treeitem"]');
    expect(taskItem).toHaveAttribute('aria-selected', 'true');
  });

  it('opens and selects the task of a deep-linked thread', async () => {
    renderPage(multiTaskStatement, '?threadId=th-other');

    expect(await screen.findByTestId('mint-thread')).toBeInTheDocument();
    const tree = screen.getByRole('tree', { name: 'Tasks' });
    const taskItem = within(tree).getByText('Water modeling').closest('[role="treeitem"]');
    expect(taskItem).toHaveAttribute('aria-selected', 'true');
    expect(toggleFor('Water modeling')).toHaveAttribute('aria-expanded', 'true');
    expect(inTree('Flood scenario')).toBeInTheDocument();
  });
});
