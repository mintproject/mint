import { useMemo } from 'react';
import { useQuery } from '@apollo/client';

import {
  GET_FLOW_CONFIGURATION_IDS,
  type GetFlowConfigurationIdsData,
} from '@/graphql/queries/flows';

export interface FlowConfigurationIds {
  ids: ReadonlySet<string>;
  /** False when the query failed: the ids are then unknown, not empty. */
  known: boolean;
}

/**
 * The ids of every flow configuration, for the model browser to join onto its
 * rows. Its own query, so a deployment where it fails loses the Flow badge and
 * facet, not the list.
 */
export function useFlowConfigurationIds(): FlowConfigurationIds {
  const { data, error } = useQuery<GetFlowConfigurationIdsData>(GET_FLOW_CONFIGURATION_IDS, {
    fetchPolicy: 'cache-first',
  });
  const ids = useMemo(
    () => new Set((data?.modelcatalog_configuration_flow ?? []).map((row) => row.configuration_id)),
    [data],
  );
  return { ids, known: !error && data !== undefined };
}
