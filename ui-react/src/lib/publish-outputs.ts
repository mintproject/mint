/** Run-form state and request shaping for the optional "Publish outputs" step. */
import type { PlanPublisher } from '@/lib/ensemble-manager';

/** The user's publish choice for one model. */
export interface PublishSelection {
  transformSpecId: string;
  values: Record<string, unknown>;
  /** The declared model output to publish, when the user could choose one. */
  outputId?: string;
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
    tokens: publisher.catalog_tokens,
    values,
    ...(selection.outputId ? { model_output_key: selection.outputId } : {}),
  };
}

export function publisherLabel(publisher: PlanPublisher): string {
  return publisher.catalog_tokens.join(' + ') || publisher.name;
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
