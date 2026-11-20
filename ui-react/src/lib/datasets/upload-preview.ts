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

/**
 * How useful a suggested variable is for these files, best first:
 * 0 an input that declares a format takes these files,
 * 1 an input takes the variable but declares no format (or no files are chosen yet),
 * 2 inputs take the variable but none takes these files,
 * 3 no registered flow or model takes it.
 */
export type SuggestionFit = 0 | 1 | 2 | 3;

export interface RankedSuggestion<T> {
  item: T;
  fit: SuggestionFit;
  /** Flows and models with an input that takes the variable, whatever the format. */
  flows: number;
  models: number;
}

function suggestionFit(consumers: UploadConsumer[]): SuggestionFit {
  if (consumers.length === 0) return 3;
  if (consumers.some((c) => c.formatFits === true && (c.format ?? '').trim())) return 0;
  if (consumers.some((c) => c.formatFits !== false)) return 1;
  return 2;
}

/**
 * Order the semantic suggestions by whether a registered flow or model could use
 * the files under that variable, keeping the semantic order within each group.
 * Text similarity alone cannot tell "a corpus of transcripts" from "frames drawn
 * from transcripts"; what the catalog's inputs accept can.
 */
export function rankSuggestionsByUse<T extends { id: string; label?: string | null }>(
  tree: GetModelTreeWithRegionsQuery | undefined,
  suggestions: T[],
  files: Array<{ name: string }>,
): RankedSuggestion<T>[] {
  return suggestions
    .map((item, index) => {
      const consumers = consumersOfVariable(
        tree,
        { id: item.id, label: item.label?.trim() || item.id },
        files,
      );
      return {
        index,
        ranked: {
          item,
          fit: suggestionFit(consumers),
          flows: consumers.filter((c) => c.kind === 'flow').length,
          models: consumers.filter((c) => c.kind === 'model').length,
        },
      };
    })
    .sort((a, b) => a.ranked.fit - b.ranked.fit || a.index - b.index)
    .map(({ ranked }) => ranked);
}

/** "Input to 6 flows and 1 model", or why nothing can use it. */
export function suggestionUseText(ranked: RankedSuggestion<unknown>): string {
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [
    ranked.flows ? count(ranked.flows, 'flow') : '',
    ranked.models ? count(ranked.models, 'model') : '',
  ].filter(Boolean);
  if (parts.length === 0) return 'No registered flow or model takes this as an input';
  const users = parts.join(' and ');
  return ranked.fit === 2 ? `Input to ${users}, but not in this file format` : `Input to ${users}`;
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
