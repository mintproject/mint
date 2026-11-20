/**
 * Boundary picker options for the Framing step's spatial map.
 *
 * A boundary option is what a person reads in the dropdown: a name, never an
 * id. The id stays in `value`. Registered MINT regions that are numbered parts
 * of one region (TRINITY_1 .. TRINITY_55) collapse into one family option whose
 * `parts` the user can expand.
 */

/** How a layer labels its features. Comes from the layer config, not the component. */
export interface BoundaryLabelConfig {
  /** Attribute holding the readable name. Defaults to the filter field. */
  label_field?: string;
  /** Text before the label, e.g. "GMA " for a layer whose only attribute is a number. */
  label_prefix?: string;
  /** Text after a label that is only the filter value, e.g. " County". */
  label_suffix?: string;
}

export interface BoundaryOption {
  /** The filter value saved with the selection. A family joins its parts' values with commas. */
  value: string;
  /** Every filter value the option stands for. One for a single boundary. */
  values: string[];
  label: string;
  /** Category heading for registered MINT regions. */
  group?: string;
  /** Present on a family: the numbered parts, sorted. */
  parts?: BoundaryOption[];
}

/** Attributes some layers carry a name in, tried in order when the config names none. */
const NAME_ATTRIBUTES = [
  'GMAName',
  'GMA_Name',
  'GMA_NAME',
  'DistrictName',
  'Name',
  'name',
  'region_name',
  'label',
];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareLabels(left: string, right: string): number {
  return collator.compare(left, right);
}

/** "TRINITY_53" becomes "Trinity 53". Names without an underscore are left as written. */
export function prettyRegionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.includes('_')) return trimmed;
  const spaced = trimmed.replace(/_+/g, ' ');
  if (spaced !== spaced.toUpperCase()) return spaced;
  return spaced.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_m, lead: string, ch: string) => {
    return `${lead}${ch.toUpperCase()}`;
  });
}

/**
 * The readable label for a feature. A named attribute wins; otherwise the
 * filter value itself, wrapped in the layer's prefix and suffix. When the layer
 * also has a name the label is "prefix value — name".
 */
export function boundaryFeatureLabel(
  properties: Record<string, unknown> | null | undefined,
  filterField: string,
  config: BoundaryLabelConfig = {},
): string {
  const props = properties ?? {};
  const raw = props[filterField];
  const value = raw == null ? '' : String(raw).trim();
  const prefix = config.label_prefix ?? '';
  const suffix = config.label_suffix ?? '';

  const nameFields = config.label_field ? [config.label_field] : NAME_ATTRIBUTES;
  let name = '';
  for (const field of nameFields) {
    const candidate = props[field];
    if (candidate != null && String(candidate).trim() !== '') {
      name = String(candidate).trim();
      break;
    }
  }

  if (name && name !== value) return `${prefix}${value} — ${name}`;
  return `${prefix}${value}${suffix}`;
}

/**
 * The family a registered region belongs to, from its name: "TRINITY_53" and
 * "Trinity 7" are both parts of the "trinity" family. A name with no trailing
 * number, or only a number, is not part of a family.
 */
export function regionFamilyOf(name: string): { key: string; label: string } | null {
  const match = /^(.*[^\s_-])[\s_-]+\d+$/.exec(name.trim());
  if (!match?.[1]) return null;
  const pretty = /^(.*[^\s-])\s+\d+$/.exec(prettyRegionName(name));
  return {
    key: match[1].toLowerCase().replace(/[\s_]+/g, ' '),
    label: pretty?.[1] ?? prettyRegionName(match[1]),
  };
}

interface RegionFeatureProps {
  region_name?: unknown;
  category_name?: unknown;
  category_id?: unknown;
}

/**
 * Options for a registered-region layer. The name is the label and the
 * category is the group. Numbered parts of one family (two or more in a
 * category) collapse to one family option.
 */
export function buildRegionOptions(
  features: GeoJSON.Feature[],
  filterField: string,
): BoundaryOption[] {
  const singles = new Map<string, BoundaryOption & { familyKey?: string; familyLabel?: string }>();
  for (const feature of features) {
    const props = (feature.properties ?? {}) as Record<string, unknown> & RegionFeatureProps;
    const raw = props[filterField];
    if (raw == null || String(raw).trim() === '') continue;
    const value = String(raw);
    if (singles.has(value)) continue;
    const rawName = props.region_name == null ? '' : String(props.region_name);
    const family = regionFamilyOf(rawName);
    const group =
      props.category_name != null
        ? String(props.category_name)
        : props.category_id != null
          ? String(props.category_id)
          : undefined;
    singles.set(value, {
      value,
      values: [value],
      label: rawName ? prettyRegionName(rawName) : value,
      group,
      familyKey: family ? `${group ?? ''}|${family.key}` : undefined,
      familyLabel: family?.label,
    });
  }

  const byFamily = new Map<string, Array<BoundaryOption & { familyLabel?: string }>>();
  for (const option of singles.values()) {
    if (!option.familyKey) continue;
    const members = byFamily.get(option.familyKey) ?? [];
    members.push(option);
    byFamily.set(option.familyKey, members);
  }

  const result: BoundaryOption[] = [];
  for (const option of singles.values()) {
    const members = option.familyKey ? byFamily.get(option.familyKey) : undefined;
    if (!members || members.length < 2) {
      result.push(stripFamily(option));
      continue;
    }
    // Emit the family once, at its first member.
    if (members[0] !== option) continue;
    const parts = members.map(stripFamily).sort((a, b) => compareLabels(a.label, b.label));
    const values = parts.flatMap((part) => part.values);
    result.push({
      value: values.join(','),
      values,
      label: `${option.familyLabel ?? option.label} (${parts.length} parts)`,
      group: option.group,
      parts,
    });
  }
  return sortBoundaryOptions(result);
}

function stripFamily(option: BoundaryOption & { familyKey?: string; familyLabel?: string }) {
  const { familyKey: _key, familyLabel: _label, ...rest } = option;
  void _key;
  void _label;
  return rest;
}

/** Options for a feature-service layer, labelled from the layer config. */
export function buildLayerOptions(
  features: GeoJSON.Feature[],
  filterField: string,
  config: BoundaryLabelConfig = {},
): BoundaryOption[] {
  const seen = new Set<string>();
  const options: BoundaryOption[] = [];
  for (const feature of features) {
    const raw = feature.properties?.[filterField];
    if (raw == null || String(raw).trim() === '') continue;
    const value = String(raw);
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({
      value,
      values: [value],
      label: boundaryFeatureLabel(feature.properties, filterField, config),
    });
  }
  return sortBoundaryOptions(options);
}

/** Sort by group, then by name. Parts of a family sort the same way. */
export function sortBoundaryOptions(options: BoundaryOption[]): BoundaryOption[] {
  return [...options].sort(
    (a, b) => compareLabels(a.group ?? '', b.group ?? '') || compareLabels(a.label, b.label),
  );
}

/** The distinct groups, sorted. */
export function boundaryGroups(options: BoundaryOption[]): string[] {
  return [...new Set(options.flatMap((o) => (o.group ? [o.group] : [])))].sort(compareLabels);
}

/** Every option including family parts, flat. */
export function flattenBoundaryOptions(options: BoundaryOption[]): BoundaryOption[] {
  return options.flatMap((option) => [option, ...(option.parts ?? [])]);
}

/**
 * Filter by what the user typed. A family stays when its own label or any part
 * matches; when a part matched, only the matching parts are kept so the user
 * sees where the match was.
 */
export function filterBoundaryOptions(options: BoundaryOption[], query: string): BoundaryOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  const matches = (label: string) => label.toLowerCase().includes(needle);
  return options.flatMap((option) => {
    if (!option.parts) return matches(option.label) ? [option] : [];
    if (matches(option.label)) return [option];
    const parts = option.parts.filter((part) => matches(part.label));
    return parts.length > 0 ? [{ ...option, parts }] : [];
  });
}

/** The option for a saved filter value: a single boundary, a part, or a whole family. */
export function findBoundaryOption(
  options: BoundaryOption[],
  value: string,
): BoundaryOption | undefined {
  return flattenBoundaryOptions(options).find((option) => option.value === value);
}
