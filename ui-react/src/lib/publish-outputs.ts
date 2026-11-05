/** Run-form state and request shaping for the optional "Publish outputs" step. */
import type { PlanPublisher } from '@/lib/ensemble-manager';

/** The user's publish choice for one model. */
export interface PublishSelection {
  transformSpecId: string;
  values: Record<string, unknown>;
  /** The declared model output to publish, when the user could choose one. */
  outputId?: string;
  /**
   * The catalogs to write, one of the publisher's `catalog_options`
   * (e.g. `['ckan']` for CKAN only). Absent means all of its `catalog_tokens`.
   */
  tokens?: string[];
}

/** What a submit carries: catalog tokens and output for the plan, values for the run. */
export interface PublishRequest {
  tokens: string[];
  values: Record<string, unknown>;
  model_output_key?: string;
}

/** A declared model output, as far as publishing needs to know it. */
export interface PublishableOutput {
  id: string;
  name: string;
  format?: string | null;
}

/**
 * The model outputs the publisher can take, in declared order: those whose
 * format is one the adapter listed for it. Empty when the adapter listed none
 * (an older adapter), in which case the Ensemble Manager chooses by itself.
 */
export function publishableOutputs<T extends PublishableOutput>(
  publisher: PlanPublisher,
  outputs: readonly T[],
): T[] {
  const formats = new Set((publisher.output_formats ?? []).map((format) => format.trim()));
  if (formats.size === 0) return [];
  return outputs.filter((output) => formats.has((output.format ?? '').trim()));
}

/**
 * The catalog token sets the user may pick for a publisher, the adapter's
 * `catalog_options` first; an older adapter offers only the full set.
 */
export function publisherCatalogOptions(publisher: PlanPublisher): string[][] {
  const options = (publisher.catalog_options ?? []).filter((option) => option.length > 0);
  return options.length > 0 ? options : [publisher.catalog_tokens];
}

/** One option's key in the Catalog select: `<transform_spec_id>::<tokens>`. */
export function catalogOptionKey(publisher: PlanPublisher, tokens: readonly string[]): string {
  return `${publisher.transform_spec_id}::${[...tokens].sort().join('+')}`;
}

/** The tokens a selection publishes to: its own choice, else the publisher's full set. */
export function selectedTokens(
  publisher: PlanPublisher,
  selection: Pick<PublishSelection, 'tokens'> | null | undefined,
): string[] {
  return selection?.tokens && selection.tokens.length > 0
    ? selection.tokens
    : publisher.catalog_tokens;
}

export function publishRequestFor(
  publishers: PlanPublisher[],
  selection: PublishSelection | null | undefined,
): PublishRequest | undefined {
  const publisher = publishers.find(
    (item) => item.transform_spec_id === selection?.transformSpecId,
  );
  if (!publisher || !selection || !publisher.can_publish.ok) return undefined;
  const values = Object.fromEntries(
    Object.entries(selection.values).filter(([, value]) => value !== undefined && value !== ''),
  );
  return {
    tokens: selectedTokens(publisher, selection),
    values,
    ...(selection.outputId ? { model_output_key: selection.outputId } : {}),
  };
}

/** `ckan + stac`, or `ckan` for a CKAN-only choice; the piece's name when it has no tokens. */
export function publisherLabel(publisher: PlanPublisher, tokens?: readonly string[]): string {
  return (tokens ?? publisher.catalog_tokens).join(' + ') || publisher.name;
}

/** Initial values for a freshly chosen publisher: each parameter's default. */
export function publisherDefaults(publisher: PlanPublisher): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const parameter of publisher.parameters) {
    if (parameter.default !== undefined && parameter.default !== null) {
      values[parameter.name] = parameter.default;
    } else if (parameter.type === 'boolean') {
      values[parameter.name] = false;
    } else if (parameter.allowed_values?.length === 1) {
      values[parameter.name] = parameter.allowed_values[0];
    }
  }
  return values;
}
