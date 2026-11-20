/**
 * Builders for the nested `thread_data` insert the UpdateThreadData mutation
 * takes when a dataset is bound to a model input.
 *
 * Extracted so the wizard's Datasets step and the standalone MintDatasets
 * component write the same rows. The shape is dictated by
 * ui/src/queries/thread/update-datasets.graphql and its Lit adapter.
 */
import { Md5 } from 'ts-md5';

import type { UpdateThreadDataMutationVariables } from '@/graphql/generated/modeling';
import type { DataCatalogDataset, DataCatalogResource } from '@/lib/data-catalog';

export type ThreadDataInsert = UpdateThreadDataMutationVariables['data'][number];

/** Deterministic UUID v4 substitute — mirrors legacy uuidv4(). */
export function newDatasliceId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Stable id for a resource: the MD5 hex digest of its URL.
 *
 * The URL is the only value CKAN guarantees is the same file across calls, and
 * `resource.id` is a text PK, so the same file must hash to the same key or the
 * insert duplicates it. **The algorithm has to be MD5, not merely stable** —
 * Lit writes `getMd5Hash(url)` (ui/src/util/graphql_adapter.ts) and TACC's rows
 * carry those digests, so any other hash makes this app store a second row for
 * a file the deployment already has. Verified against a live TACC dataslice.
 */
export function hashResourceId(url: string): string {
  return Md5.hashStr(url);
}

/** The most files one collection input can hold (the Ensemble Manager's limit). */
export const COLLECTION_FILE_CAP = 500;

/** Only https and Tapis storage locations can be gathered; http is refused. */
export function isGatherableUrl(url: string | null | undefined): boolean {
  return /^(https|tapis):\/\//i.test((url ?? '').trim());
}

/** What a collection input keeps from a dataset's files: gatherable ones, up to the cap. */
export function collectionDefaultSelection(
  resources: DataCatalogResource[],
): DataCatalogResource[] {
  return resources.filter((r) => isGatherableUrl(r.url)).slice(0, COLLECTION_FILE_CAP);
}

function isoDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().split('T')[0] ?? null;
}

/**
 * One `thread_data` row: a dataslice of the chosen dataset, narrowed to the
 * resources the caller kept, with the dataset and resources upserted alongside.
 */
export function buildThreadDataInsert(params: {
  threadId: string;
  threadName?: string | null;
  regionId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  datasliceId: string;
  /** Only the id and name are stored; a full catalog dataset satisfies this. */
  dataset: Pick<DataCatalogDataset, 'id' | 'name'>;
  resources: DataCatalogResource[];
}): ThreadDataInsert {
  const { dataset, resources } = params;
  const kept = resources.filter((r) => r.selected !== false);
  return {
    thread_id: params.threadId,
    dataslice: {
      data: {
        id: params.datasliceId,
        name: `${dataset.name} for thread: ${params.threadName ?? ''}`,
        region_id: params.regionId ?? '',
        start_date: params.startDate ?? null,
        end_date: params.endDate ?? null,
        // The count of what is actually bound, not what the package holds: a
        // dataset matches an input because *some* of its resources carry the
        // variable, and only those are kept.
        resource_count: kept.length,
        dataset: {
          data: { id: dataset.id, name: dataset.name },
          on_conflict: { constraint: 'dataset_pkey', update_columns: ['name'] },
        },
        resources: {
          data: kept.map((r) => ({
            resource: {
              data: {
                id: hashResourceId(r.url),
                dcid: r.id,
                name: r.name,
                url: r.url,
                start_date: isoDate(r.time_period?.start_date),
                end_date: isoDate(r.time_period?.end_date),
              },
              on_conflict: { constraint: 'resource_pkey', update_columns: ['name'] },
            },
            selected: true,
          })),
          on_conflict: {
            constraint: 'dataslice_resource_pkey',
            update_columns: ['dataslice_id'],
          },
        },
      },
      on_conflict: { constraint: 'dataslice_pkey', update_columns: ['id'] },
    },
  };
}
