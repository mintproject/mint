/**
 * "Who can use this" for the upload page: the registered flows and models that
 * have an input taking a given standard variable, and whether the chosen files'
 * format fits that input.
 *
 * Reads the model tree the app already loads (GetModelTreeWithRegions), so it
 * needs no new catalog query and never calls the SVO adapter.
 */
import { checkUploadAgainstInput } from '@/lib/ckan-upload';
import { canonicalStandardVariable } from '@/lib/datasets/ckan';
import {
  extractModelIO,
  type GetModelTreeWithRegionsQuery,
  type ModelIOConfig,
} from '@/graphql/generated/modeling';

export interface UploadConsumer {
  id: string;
  name: string;
  kind: 'flow' | 'model';
  inputName: string;
  /** The input's declared format, if any. */
  format: string | null;
  /** True or false once files are chosen; null while there are none to compare. */
  formatFits: boolean | null;
  /** Why the format does not fit, when it does not. */
  formatProblem: string | null;
}

export function consumersOfVariable(
  tree: GetModelTreeWithRegionsQuery | undefined,
  variable: { id: string; label: string },
  files: Array<{ name: string }>,
): UploadConsumer[] {
  if (!tree) return [];
  const wanted = new Set([variable.id, variable.label].map(canonicalStandardVariable));
  const found = new Map<string, UploadConsumer>();
  const visit = (config: ModelIOConfig, kind: 'flow' | 'model') => {
    for (const input of extractModelIO(config).inputs) {
      const matches = [...input.variableIds, ...input.variableLabels].some((v) =>
        wanted.has(canonicalStandardVariable(v)),
      );
      if (!matches || found.has(config.id)) continue;
      const fit =
        files.length === 0
          ? null
          : checkUploadAgainstInput({
              files,
              format: input.format,
              variables: [variable.label],
              multiple: true,
              inputName: input.name,
            });
      found.set(config.id, {
        id: config.id,
        name: config.label ?? config.id,
        kind,
        inputName: input.name,
        format: input.format ?? null,
        formatFits: fit ? fit.error === null : null,
        formatProblem: fit?.error ?? null,
      });
    }
  };
  for (const software of tree.modelcatalog_software) {
    for (const version of software.versions) {
      for (const config of version.configurations) {
        const kind = config.flow ? 'flow' : 'model';
        visit(config, kind);
        for (const child of config.child_configurations) visit(child, kind);
      }
    }
  }
  return [...found.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
}

export interface CloseConsumer extends UploadConsumer {
  /** The close variable whose input this matched on. */
  via: string;
}

/**
 * Flows and models whose inputs take a variable CLOSE to the chosen one, for the
 * "not an exact fit" list. A config already in the exact list is left out.
 */
export function closeConsumers(
  tree: GetModelTreeWithRegionsQuery | undefined,
  similar: Array<{ id: string; label?: string | null }>,
  exact: UploadConsumer[],
  files: Array<{ name: string }>,
): CloseConsumer[] {
  const seen = new Set(exact.map((consumer) => consumer.id));
  const found: CloseConsumer[] = [];
  for (const item of similar) {
    const variable = { id: item.id, label: item.label?.trim() || item.id };
    for (const consumer of consumersOfVariable(tree, variable, files)) {
      if (seen.has(consumer.id)) continue;
      seen.add(consumer.id);
      found.push({ ...consumer, via: variable.label });
    }
  }
  return found;
}
