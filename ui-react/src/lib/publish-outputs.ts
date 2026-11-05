/** Run-form state and request shaping for the optional "Publish outputs" step. */
import type { PlanPublisher } from '@/lib/ensemble-manager';

/** The user's publish choice for one model. */
export interface PublishSelection {
  transformSpecId: string;
  values: Record<string, unknown>;
}

/** What a submit carries: catalog tokens for the plan, values for the run. */
export interface PublishRequest {
  tokens: string[];
  values: Record<string, unknown>;
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
  return { tokens: publisher.catalog_tokens, values };
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
