/**
 * Routes to a wanted result: the pieces the adapter proposes (`produces`), sorted
 * into the ways a person would think of them, and taken into the flow in one go.
 *
 * Nothing here ranks by closeness. Groups are by KIND of route:
 *
 * - ready: every input already has a source in the flow;
 * - model: a piece that needs a model's output (the model is run in a thread);
 * - data: a dataset can feed it, or it converts what the flow already has;
 * - converters: pieces that only change a variable's unit or format and have
 *   nothing to convert yet;
 * - none: no route in sight.
 */
import {
  addFlowInput,
  addStep,
  appendChain,
  type FlowDraft,
  type WireJson,
} from './flow-authoring';
import type { NeedProviders, Proposal } from './flow-authoring-api';

export type RouteEntry = Proposal['produces'][number];
export type RouteNeed = RouteEntry['inputs'][number];
export type RouteModel = NeedProviders['models'][number];
export type RouteDataset = NeedProviders['datasets'][number];

/** The provider a person picked to supply one unmet input. */
export type RouteChoice =
  | { input: number; kind: 'model'; model: RouteModel }
  | { input: number; kind: 'dataset'; dataset: RouteDataset };

/** A piece that only converts: its output carries a variable one of its inputs takes. */
export function isConverter(entry: RouteEntry): boolean {
  if (typeof entry.converter === 'boolean') return entry.converter;
  const made = entry.output_variable;
  return Boolean(made) && entry.inputs.some((need) => need.variable === made);
}

const unmet = (entry: RouteEntry) => entry.inputs.filter((need) => !need.met);
const modelsOf = (need: RouteNeed) => need.providers?.models ?? [];
const datasetsOf = (need: RouteNeed) => need.providers?.datasets ?? [];

export type RouteKind = 'ready' | 'model' | 'data' | 'converter' | 'none';

export function routeKind(entry: RouteEntry): RouteKind {
  const converter = isConverter(entry);
  if (entry.complete) return converter ? 'data' : 'ready';
  const needs = unmet(entry);
  if (converter) return needs.some((need) => datasetsOf(need).length > 0) ? 'data' : 'converter';
  if (needs.some((need) => modelsOf(need).length > 0)) return 'model';
  if (needs.some((need) => datasetsOf(need).length > 0)) return 'data';
  return 'none';
}

export type RouteGroups = Record<RouteKind, RouteEntry[]>;

/** Sort entries into groups, keeping the adapter's order inside each. */
export function groupRoutes(produces: readonly RouteEntry[]): RouteGroups {
  const groups: RouteGroups = { ready: [], model: [], data: [], converter: [], none: [] };
  for (const entry of produces) groups[routeKind(entry)].push(entry);
  return groups;
}

/** Datasets listed once each, by data object id. */
export function uniqueDatasets(datasets: readonly RouteDataset[]): RouteDataset[] {
  const seen = new Set<string>();
  return datasets.filter((dataset) => {
    if (seen.has(dataset.data_object_id)) return false;
    seen.add(dataset.data_object_id);
    return true;
  });
}

/** Model outputs listed once each (a configuration and the output it makes). */
export function uniqueModels(models: readonly RouteModel[]): RouteModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = `${model.configuration_id}#${model.output ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const looksLikeUri = (text: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith('urn:');

/** A name for a dataset: the adapter's name, else a label that is not a URI, else its id. */
export function datasetName(dataset: RouteDataset): string {
  const name = dataset.name?.trim();
  if (name && !looksLikeUri(name)) return name;
  const label = dataset.label?.trim();
  if (label && !looksLikeUri(label)) return label;
  return dataset.data_object_id;
}

/** A piece's name for people: slug-like labels ("flow-cfs-to-m3s") read as words. */
export function readableName(label: string): string {
  const text = label.trim();
  if (/^[A-Za-z0-9]+([-_][A-Za-z0-9]+)+$/.test(text)) {
    const words = text.replace(/[-_]+/g, ' ');
    return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  }
  return text;
}

/** Readable names for file formats that name no standard variable. One place. */
export const FORMAT_NAMES: Record<string, string> = {
  'cbc-mf6': 'MODFLOW 6 cell-by-cell budget',
  'cbc-mf2005': 'MODFLOW-2005 cell-by-cell budget',
  'cbc-mf2000': 'MODFLOW-2000 cell-by-cell budget',
  'cbc-mf96': 'MODFLOW-96 cell-by-cell budget',
  'cbc-mfusg': 'MODFLOW-USG cell-by-cell budget',
  'gma-scalar': 'GMA summary value',
};

/** A format as people read it: "MODFLOW 6 cell-by-cell budget", else "a csv file". */
export function formatName(format: string): string {
  return FORMAT_NAMES[format.trim().toLowerCase()] ?? `a ${format.trim()} file`;
}

/**
 * What an input takes, for people: its variable's label; with no variable, the
 * label of the model output that would make it, else the format's readable name.
 * The format follows in parentheses unless the name already says it.
 */
export function needName(need: RouteNeed): string {
  const format = need.format?.trim() ?? '';
  const named =
    need.variable_label?.trim() ||
    (need.variable ? need.variable.split('/').pop() || '' : '') ||
    need.providers?.models.find((model) => model.output_label?.trim())?.output_label?.trim() ||
    (format ? formatName(format) : '');
  if (!named) return 'a file';
  return format && !named.includes(format) && named !== `a ${format} file`
    ? `${named} (${format})`
    : named;
}

/** What a model's output is called: its own label, else the variable's, else the format's. */
export const modelOutputName = (model: RouteModel, need: RouteNeed): string =>
  model.output_label?.trim() ||
  need.variable_label?.trim() ||
  (model.format || need.format ? formatName((model.format || need.format) as string) : 'output');

/**
 * Take a whole route into the draft, in order, as the form's own steps and wires:
 *
 * 1. each input that is only met through a converter chain gets the chain's pieces,
 *    each wired to the one before;
 * 2. the input the person chose a provider for gets a new flow input, named for the
 *    model's output (or the dataset) and bound to its standard variable and format;
 * 3. the piece itself is added, with every input wired that has a source.
 *
 * An input with no direct source, chain or chosen provider is left unwired; the
 * live check says so. This never claims the route is complete.
 */
export function applyRoute(draft: FlowDraft, entry: RouteEntry, choice?: RouteChoice): FlowDraft {
  let next = draft;
  const wires: WireJson[] = [];
  for (const need of entry.inputs) {
    const direct = need.direct[0];
    const chain = need.chains[0];
    if (direct) {
      wires.push(direct.wire);
    } else if (chain) {
      const appended = appendChain(next, chain);
      next = appended.draft;
      if (appended.from) wires.push({ to: { input: need.input }, from: appended.from });
    } else if (
      choice &&
      choice.input === need.input &&
      (need.variable || need.format || choice.kind === 'model')
    ) {
      const added = addFlowInput(next, {
        label:
          choice.kind === 'model'
            ? modelOutputName(choice.model, need)
            : datasetName(choice.dataset),
        standardVariable: (choice.kind === 'model' && choice.model.variable) || need.variable || '',
        standardVariableLabel: need.variable_label ?? undefined,
        format:
          (choice.kind === 'model' ? choice.model.format : choice.dataset.format) ||
          need.format ||
          '',
      });
      next = added.draft;
      wires.push({ to: { input: need.input }, from: { flow_input: added.key } });
    }
  }
  return addStep(next, entry.piece, wires);
}
