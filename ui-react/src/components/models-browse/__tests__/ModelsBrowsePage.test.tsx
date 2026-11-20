import type { MockedResponse } from '@apollo/client/testing';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { SearchModelConfigurationsDocument } from '@/graphql/generated/graphql';
import { GET_FLOW_CONFIGURATION_IDS } from '@/graphql/queries/flows';
import { renderWithProviders, screen, waitFor, within } from '@/test/utils/render';
import { ModelsBrowsePage } from '../ModelsBrowsePage';

const version = {
  __typename: 'modelcatalog_software_version',
  id: 'v1',
  version_id: '1',
  software: { __typename: 'modelcatalog_software', id: 'sw1', label: 'Suite' },
};
const row = (id: string, label: string) => ({
  __typename: 'modelcatalog_configuration',
  id,
  label,
  model_configuration_id: null,
  software_version: version,
  parent_configuration: null,
});

const searchMock: MockedResponse = {
  request: { query: SearchModelConfigurationsDocument },
  variableMatcher: () => true,
  result: {
    data: {
      modelcatalog_configuration: [
        row('cfg-model', 'Plain model'),
        row('cfg-flow', 'Dictionary flow'),
      ],
    },
  },
};

const flowIdsMock = (ids: string[]): MockedResponse => ({
  request: { query: GET_FLOW_CONFIGURATION_IDS },
  result: {
    data: {
      modelcatalog_configuration_flow: ids.map((configuration_id) => ({
        __typename: 'modelcatalog_configuration_flow',
        configuration_id,
      })),
    },
  },
});

const render = (mocks: MockedResponse[], url = '/models') =>
  renderWithProviders(<ModelsBrowsePage basePath="/models" />, {
    apolloMocks: mocks,
    initialEntries: [url],
  });

/** The browse list expands its groups only under an active filter; open it. */
async function openGroup() {
  const trigger = await screen.findByRole('button', { name: /Suite/ });
  if (trigger.getAttribute('aria-expanded') !== 'true') await userEvent.click(trigger);
}

describe('ModelsBrowsePage flows', () => {
  it('badges a flow row and not a model row', async () => {
    render([searchMock, flowIdsMock(['cfg-flow'])]);
    await openGroup();
    const flowRow = (await screen.findByText('Dictionary flow')).closest('a')!;
    await waitFor(() => expect(within(flowRow).getByText('Flow')).toBeInTheDocument());
    expect(within(screen.getByText('Plain model').closest('a')!).queryByText('Flow')).toBeNull();
  });

  it('filters to flows or to models with the kind facet', async () => {
    render([searchMock, flowIdsMock(['cfg-flow'])], '/models?type=flows');
    await openGroup();
    expect(await screen.findByText('Dictionary flow')).toBeInTheDocument();
    expect(screen.queryByText('Plain model')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Models' }));
    expect(await screen.findByText('Plain model')).toBeInTheDocument();
    expect(screen.queryByText('Dictionary flow')).not.toBeInTheDocument();

    // With no filter active the groups collapse again.
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await openGroup();
    expect(await screen.findByText('Dictionary flow')).toBeInTheDocument();
    expect(screen.getByText('Plain model')).toBeInTheDocument();
  });

  it('still lists every configuration when the flow-id query errors', async () => {
    render(
      [
        searchMock,
        {
          request: { query: GET_FLOW_CONFIGURATION_IDS },
          error: new Error('field "modelcatalog_configuration_flow" not found'),
        },
      ],
      '/models?type=flows',
    );
    await openGroup();
    expect(await screen.findByText('Dictionary flow')).toBeInTheDocument();
    expect(screen.getByText('Plain model')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Kind' })).not.toBeInTheDocument();
    expect(screen.queryByText('Flow')).not.toBeInTheDocument();
  });
});
