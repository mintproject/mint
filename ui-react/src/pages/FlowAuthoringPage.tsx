/**
 * FlowAuthoringPage — build a flow in the web app.
 *
 * /flows/new           a new flow.
 * /flows/new/:slugid   the form prefilled from an existing flow. A flow is never
 *                      changed in place: saving writes a NEW configuration under the
 *                      same version, and the old one stays until its owner deletes it.
 */
import { useMemo } from 'react';
import { useQuery } from '@apollo/client';
import { Link, useParams } from 'react-router-dom';

import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { FlowAuthoringForm } from '@/components/flows/FlowAuthoringForm';
import {
  GET_FLOW_FOR_COPY,
  GET_FLOW_PIECES,
  type GetFlowForCopyData,
  type GetFlowPiecesData,
} from '@/graphql/queries/flow-authoring';
import { useAuth } from '@/lib/auth/useAuth';
import { draftFromStoredFlow } from '@/lib/flow-authoring';
import { slugMatchPattern } from '@/lib/uri';

export function FlowAuthoringPage() {
  const { slugid } = useParams<{ slugid?: string }>();
  const { accessToken } = useAuth();
  const pieces = useQuery<GetFlowPiecesData>(GET_FLOW_PIECES, { fetchPolicy: 'cache-and-network' });
  const source = useQuery<GetFlowForCopyData>(GET_FLOW_FOR_COPY, {
    variables: { pattern: slugMatchPattern(slugid ?? '') },
    skip: !slugid,
    fetchPolicy: 'cache-and-network',
  });

  const stored = source.data?.modelcatalog_configuration[0];
  const initial = useMemo(
    () =>
      stored?.flow ? draftFromStoredFlow({ configuration: stored, flow: stored.flow }) : undefined,
    [stored],
  );

  const loading = pieces.loading || (slugid ? source.loading : false);
  const notFlow = Boolean(slugid) && !source.loading && !initial;

  return (
    <div className="container min-w-0 max-w-4xl py-6">
      <h1 className="text-2xl font-bold">{slugid ? 'Edit a flow as a copy' : 'Build a flow'}</h1>
      <p className="mb-4 text-muted-foreground">
        Chain ETL pieces into a model. The adapter checks every change, and the flow can be saved
        only when it fits its pieces.
      </p>
      {loading && !pieces.data && <LoadingSpinner />}
      {pieces.error && (
        <p role="alert" className="text-destructive">
          Unable to load the pieces: {pieces.error.message}
        </p>
      )}
      {notFlow && (
        <p role="alert" className="text-destructive">
          That configuration is not a flow, or you cannot see it.{' '}
          <Link className="underline" to="/flows/new">
            Start a new flow
          </Link>
        </p>
      )}
      {pieces.data && (!slugid || initial) && (
        <FlowAuthoringForm
          key={initial?.configuration.label ?? 'new'}
          initial={initial}
          pieces={pieces.data.modelcatalog_etl_process}
          token={accessToken}
        />
      )}
    </div>
  );
}
