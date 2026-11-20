/**
 * Building a flow in the form: the draft the author edits, the bodies it becomes,
 * and the edits that keep a draft consistent.
 *
 * A step's position is its place in the list, from 1. Every wire that names a step
 * names it by position, so adding or removing a step renumbers the wires that read
 * from the steps after it. A wire is the adapter's own form (see `flow-steps.ts`):
 *
 *   to    {"input": k} | {"setting": name} | {}
 *   from  {"flow_input": key} | {"flow_parameter": name} | {"step": n, "output": k}
 *         | {"step": n, "value": name} | {"step": n}
 *
 * The draft is never sent as it is: `buildCheckBody` is for the adapter's check and
 * proposals, `buildSaveBody` for `POST /flows` on the model catalog API.
 */
import type { FlowPieceRow } from '@/graphql/queries/flows';
import { parseWires, parseSettings } from './flow-steps';

export interface WireJson {
  to: Record<string, unknown>;
  from: Record<string, unknown>;
}

export interface DraftInput {
  /** A plain name, unique in the flow: how wires and bindings name the input. */
  key: string;
  label: string;
  standardVariable: string;
  standardVariableLabel: string;
  format: string;
  optional: boolean;
}

export interface DraftStep {
  pieceId: string;
  /** The flow's defaults for the piece's settings. A blank value is not sent. */
  settings: Record<string, string>;
  wires: WireJson[];
  pauseAfter: boolean;
}

export interface DraftOutput {
  step: number;
  kind: 'output' | 'value' | 'record';
  /** The output position (as text), or the value or record name. */
  ref: string;
  label: string;
  format: string;
  /** For a paused step: the file the person edits (`{file, check?, key?}`). The form
   * keeps it as it was read; the catalog and the adapter's check hold it to the rules. */
  editable?: Json;
}

/** `''`, `input:<key>` or `setting:<name>`. */
export type BindingTarget = string;

export interface DraftBindings {
  region: BindingTarget;
  start_date: BindingTarget;
  end_date: BindingTarget;
  /** Keys of the inputs that each take a collection of files. */
  collections: string[];
}

export interface FlowDraft {
  software: { id: string; label: string };
  version: { id: string; label: string };
  configuration: { label: string; description: string };
  inputs: DraftInput[];
  steps: DraftStep[];
  outputs: DraftOutput[];
  bindings: DraftBindings;
}

export const MAX_STEPS = 24;
export const BINDING_ROLES = ['region', 'start_date', 'end_date'] as const;
export type BindingRole = (typeof BINDING_ROLES)[number];

export function emptyDraft(): FlowDraft {
  return {
    software: { id: '', label: '' },
    version: { id: '', label: '' },
    configuration: { label: '', description: '' },
    inputs: [],
    steps: [],
    outputs: [],
    bindings: { region: '', start_date: '', end_date: '', collections: [] },
  };
}

// ---------------------------------------------------------------------------
// What the draft becomes
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const bindingJson = (target: BindingTarget, forSave: boolean): Json | null => {
  const [kind, ...rest] = target.split(':');
  const name = rest.join(':');
  if (!name) return null;
  if (kind === 'input') return { input: name };
  // The catalog names a setting; the adapter's check names a flow parameter, and
  // the draft's settings are not flow parameters, so the check never sees one.
  return kind === 'setting' && forSave ? { setting: name } : null;
};

function stepsJson(draft: FlowDraft) {
  return draft.steps.map((step, index) => ({
    position: index + 1,
    etl_process_id: step.pieceId || null,
    settings: Object.fromEntries(Object.entries(step.settings).filter(([, value]) => value !== '')),
    wires: step.wires,
    pause_after: step.pauseAfter,
  }));
}

/** `editable` as the catalog takes it: a blank check or key is left out. */
function editableJson(editable: Json): Json {
  const { check, key, ...rest } = editable;
  return {
    ...rest,
    ...(typeof check === 'string' && check !== '' ? { check } : {}),
    ...(typeof key === 'string' && key !== '' ? { key } : {}),
  };
}

function outputJson(output: DraftOutput, forSave: boolean): Json {
  const where: Json = { step: output.step };
  if (output.kind === 'output') where.output = Number(output.ref);
  else where[output.kind] = output.ref;
  if (forSave && output.kind === 'output') {
    where.label = output.label;
    if (output.format) where.format = output.format;
  }
  if (output.kind === 'output' && output.editable) where.editable = editableJson(output.editable);
  return where;
}

/** The body of the adapter's `POST /flows/check` and `POST /flows/propose`. */
export function buildCheckBody(draft: FlowDraft) {
  const bindings: Json = {};
  for (const role of BINDING_ROLES) {
    const target = bindingJson(draft.bindings[role], false);
    if (target) bindings[role] = target;
  }
  if (draft.bindings.collections.length > 0) bindings.collections = draft.bindings.collections;
  return {
    inputs: draft.inputs.map((input) => ({
      id: input.key,
      contract: {
        standard_variable_uri: input.standardVariable || null,
        format: input.format || null,
      },
    })),
    steps: stepsJson(draft),
    outputs: draft.outputs.map((output) => outputJson(output, false)),
    thread_bindings: bindings,
  };
}

/** The body of `POST /flows` on the model catalog API. */
export function buildSaveBody(draft: FlowDraft) {
  const bindings: Json = {};
  for (const role of BINDING_ROLES) {
    const target = bindingJson(draft.bindings[role], true);
    if (target) bindings[role] = target;
  }
  if (draft.bindings.collections.length > 0) bindings.collections = draft.bindings.collections;
  const parent = (part: { id: string; label: string }) => ({
    ...(part.id ? { id: part.id } : {}),
    ...(part.label ? { label: part.label } : {}),
  });
  return {
    software: parent(draft.software),
    version: parent(draft.version),
    configuration: {
      label: draft.configuration.label,
      ...(draft.configuration.description ? { description: draft.configuration.description } : {}),
    },
    inputs: draft.inputs.map((input) => ({
      key: input.key,
      label: input.label || input.key,
      standard_variable: input.standardVariable,
      ...(input.format ? { format: input.format } : {}),
      optional: input.optional,
    })),
    steps: stepsJson(draft),
    outputs: draft.outputs.map((output) => outputJson(output, true)),
    thread_bindings: bindings,
  };
}

// ---------------------------------------------------------------------------
// Edits that keep positions right
// ---------------------------------------------------------------------------

const fromStep = (wire: WireJson): number | null =>
  typeof wire.from.step === 'number' ? wire.from.step : null;

function shiftWires(wires: WireJson[], atOrAfter: number, by: number): WireJson[] {
  return wires.map((wire) => {
    const source = fromStep(wire);
    return source !== null && source >= atOrAfter
      ? { ...wire, from: { ...wire.from, step: source + by } }
      : wire;
  });
}

/**
 * Insert steps so the first has position `index + 1`. Steps from there on move
 * down by the number inserted, and so does every wire and output that names them.
 * The new steps' wires are given with final positions.
 */
export function insertSteps(draft: FlowDraft, index: number, added: DraftStep[]): FlowDraft {
  const before = draft.steps.slice(0, index);
  const after = draft.steps
    .slice(index)
    .map((step) => ({ ...step, wires: shiftWires(step.wires, index + 1, added.length) }));
  return {
    ...draft,
    steps: [...before, ...added, ...after],
    outputs: draft.outputs.map((output) =>
      output.step >= index + 1 ? { ...output, step: output.step + added.length } : output,
    ),
  };
}

/** Remove a step, and every wire and output that read from it. */
export function removeStep(draft: FlowDraft, index: number): FlowDraft {
  const position = index + 1;
  return {
    ...draft,
    steps: draft.steps
      .filter((_, at) => at !== index)
      .map((step) => ({
        ...step,
        wires: shiftWires(
          step.wires.filter((wire) => fromStep(wire) !== position),
          position + 1,
          -1,
        ),
      })),
    outputs: draft.outputs
      .filter((output) => output.step !== position)
      .map((output) => (output.step > position ? { ...output, step: output.step - 1 } : output)),
  };
}

export function updateStep(draft: FlowDraft, index: number, change: Partial<DraftStep>): FlowDraft {
  return {
    ...draft,
    steps: draft.steps.map((step, at) => (at === index ? { ...step, ...change } : step)),
  };
}

// --- a pause and the file it makes editable ---------------------------------------

/** What the catalog allows for `editable.check` and `editable.key`. */
export const EDIT_CHECKS = ['json', 'lexicon'] as const;
const EDIT_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_FILE_NAME = 200;

/** The file a paused step makes editable: which output, and what the person edits. */
export interface EditableChoice {
  /** The output position of the step, as text. */
  ref: string;
  file: string;
  check: string;
  key: string;
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The choice a step's pause has made, read from the draft's outputs. */
export function editableChoice(draft: FlowDraft, position: number): EditableChoice | null {
  const output = draft.outputs.find(
    (item) => item.step === position && item.kind === 'output' && item.editable,
  );
  if (!output?.editable) return null;
  return {
    ref: output.ref,
    file: textOf(output.editable.file),
    check: textOf(output.editable.check),
    key: textOf(output.editable.key),
  };
}

/**
 * Make one of a step's file outputs the editable one, or none (`null`). The output
 * is added to the flow's outputs when it is not there yet.
 */
export function setEditable(
  draft: FlowDraft,
  position: number,
  choice: EditableChoice | null,
): FlowDraft {
  const cleared = draft.outputs.map((item) => {
    if (item.step !== position || !item.editable) return item;
    const { editable: _dropped, ...rest } = item;
    return rest;
  });
  if (!choice || choice.ref === '') return { ...draft, outputs: cleared };
  const editable = { file: choice.file, check: choice.check, key: choice.key };
  const found = cleared.some(
    (item) => item.step === position && item.kind === 'output' && item.ref === choice.ref,
  );
  return {
    ...draft,
    outputs: found
      ? cleared.map((item) =>
          item.step === position && item.kind === 'output' && item.ref === choice.ref
            ? { ...item, editable }
            : item,
        )
      : [
          ...cleared,
          {
            step: position,
            kind: 'output',
            ref: choice.ref,
            label: `Output ${cleared.length + 1}`,
            format: '',
            editable,
          },
        ],
  };
}

/** Pause or resume a step. A step that no longer pauses has no editable file. */
export function setPause(draft: FlowDraft, index: number, pause: boolean): FlowDraft {
  const updated = updateStep(draft, index, { pauseAfter: pause });
  return pause ? updated : setEditable(updated, index + 1, null);
}

/** What stops a paused step being saved: it must name the file the person edits. */
export function pauseProblems(draft: FlowDraft): FlowProblem[] {
  const problems: FlowProblem[] = [];
  draft.steps.forEach((step, index) => {
    if (!step.pauseAfter) return;
    const step_ = index + 1;
    const refuse = (message: string) => problems.push({ code: 'FLOW_PAUSE', message, step: step_ });
    const choice = editableChoice(draft, step_);
    if (!choice) {
      refuse('Choose the file output the person edits at this pause, and name the file.');
    } else if (
      !choice.file ||
      /[/\\]/.test(choice.file) ||
      choice.file.startsWith('.') ||
      choice.file.length > MAX_FILE_NAME
    ) {
      refuse('Name the file to edit: a plain file name, with no folder and no leading dot.');
    } else if (choice.key !== '' && !EDIT_KEY.test(choice.key)) {
      refuse('The key is a lower-case name such as lexicon_uri.');
    }
  });
  return problems;
}

/** The index in a step's wires of the one that feeds input `position`, or -1. */
export function inputWireIndex(step: DraftStep, position: number): number {
  return step.wires.findIndex((wire) => wire.to.input === position);
}

/** Feed input `position` of a step from `from`, or from nothing (`null`). */
export function setInputWire(
  draft: FlowDraft,
  index: number,
  position: number,
  from: Json | null,
): FlowDraft {
  const step = draft.steps[index];
  if (!step) return draft;
  const others = step.wires.filter((wire) => wire.to.input !== position);
  return updateStep(draft, index, {
    wires: from ? [...others, { to: { input: position }, from }] : others,
  });
}

export function removeWire(draft: FlowDraft, index: number, wireIndex: number): FlowDraft {
  const step = draft.steps[index];
  if (!step) return draft;
  return updateStep(draft, index, { wires: step.wires.filter((_, at) => at !== wireIndex) });
}

/** Remove a flow input, the wires that read it and the bindings that name it. */
export function removeInput(draft: FlowDraft, key: string): FlowDraft {
  const unbound = (target: BindingTarget) => (target === `input:${key}` ? '' : target);
  return {
    ...draft,
    inputs: draft.inputs.filter((input) => input.key !== key),
    steps: draft.steps.map((step) => ({
      ...step,
      wires: step.wires.filter((wire) => wire.from.flow_input !== key),
    })),
    bindings: {
      region: unbound(draft.bindings.region),
      start_date: unbound(draft.bindings.start_date),
      end_date: unbound(draft.bindings.end_date),
      collections: draft.bindings.collections.filter((item) => item !== key),
    },
  };
}

const newStep = (pieceId: string, wires: WireJson[] = []): DraftStep => ({
  pieceId,
  settings: {},
  wires,
  pauseAfter: false,
});

export function addStep(draft: FlowDraft, pieceId: string, wires: WireJson[] = []): FlowDraft {
  return insertSteps(draft, draft.steps.length, [newStep(pieceId, wires)]);
}

// --- accepting a proposal ----------------------------------------------------

export interface ProposedSource {
  kind: 'flow_input' | 'step_output';
  id?: string;
  step?: number;
  output?: number;
}

export const wireFromSource = (source: ProposedSource): Json =>
  source.kind === 'flow_input'
    ? { flow_input: source.id }
    : { step: source.step, output: source.output };

export interface ProposedChain {
  from: ProposedSource;
  pieces: { piece: string; label?: string | null; position: number; output: number }[];
}

/** Take a direct source: feed the input from it. */
export function applyDirect(
  draft: FlowDraft,
  index: number,
  position: number,
  source: ProposedSource,
): FlowDraft {
  return setInputWire(draft, index, position, wireFromSource(source));
}

/**
 * Take a converter chain: put its pieces just before the step, each reading from
 * the one before, and feed the input from the last one.
 */
export function applyChain(
  draft: FlowDraft,
  index: number,
  position: number,
  chain: ProposedChain,
): FlowDraft {
  const added = chain.pieces.map((piece, at) => {
    const from =
      at === 0
        ? wireFromSource(chain.from)
        : { step: index + at, output: chain.pieces[at - 1]?.output };
    return newStep(piece.piece, [{ to: { input: piece.position }, from }]);
  });
  const last = chain.pieces[chain.pieces.length - 1];
  const inserted = insertSteps(draft, index, added);
  return setInputWire(inserted, index + added.length, position, {
    step: index + added.length,
    output: last?.output,
  });
}

/**
 * Put a converter chain at the END of the flow: each piece reads from the one
 * before it, the first from the chain's source. Returns the draft and where the
 * last piece's output is (a wire source), or null for an empty chain.
 */
export function appendChain(
  draft: FlowDraft,
  chain: ProposedChain,
): { draft: FlowDraft; from: Json | null } {
  const base = draft.steps.length;
  const added = chain.pieces.map((piece, at) =>
    newStep(piece.piece, [
      {
        to: { input: piece.position },
        from:
          at === 0
            ? wireFromSource(chain.from)
            : { step: base + at, output: chain.pieces[at - 1]?.output },
      },
    ]),
  );
  const last = chain.pieces[chain.pieces.length - 1];
  return {
    draft: insertSteps(draft, base, added),
    from: last ? { step: base + added.length, output: last.output } : null,
  };
}

/** Add a flow input for a standard variable, named after `label`. */
export function addFlowInput(
  draft: FlowDraft,
  input: {
    label: string;
    standardVariable: string;
    standardVariableLabel?: string;
    format?: string;
  },
): { draft: FlowDraft; key: string } {
  const key = plainKey(input.label, new Set(draft.inputs.map((item) => item.key)));
  return {
    key,
    draft: {
      ...draft,
      inputs: [
        ...draft.inputs,
        {
          key,
          label: input.label,
          standardVariable: input.standardVariable,
          standardVariableLabel:
            input.standardVariableLabel || input.standardVariable.split('/').pop() || '',
          format: input.format ?? '',
          optional: false,
        },
      ],
    },
  };
}

/** Add a step that takes output `output` of step `step` at input `input`. */
export function applyNext(
  draft: FlowDraft,
  next: { piece: string; input: number },
  from: { step: number; output: number },
): FlowDraft {
  return addStep(draft, next.piece, [
    { to: { input: next.input }, from: { step: from.step, output: from.output } },
  ]);
}

/** Add a step that makes a wanted result, fed from every input that has a direct source. */
export function applyProduces(
  draft: FlowDraft,
  entry: { piece: string; inputs: { input: number; direct: { wire: WireJson }[] }[] },
): FlowDraft {
  const wires = entry.inputs.flatMap((need) => (need.direct[0] ? [need.direct[0].wire] : []));
  return addStep(draft, entry.piece, wires);
}

// ---------------------------------------------------------------------------
// Problems, on the step and link they are on
// ---------------------------------------------------------------------------

export interface FlowProblem {
  code: string;
  message: string;
  step?: number;
  wire?: number;
}

export interface SortedProblems {
  flow: FlowProblem[];
  steps: Map<number, FlowProblem[]>;
}

export function sortProblems(problems: readonly FlowProblem[]): SortedProblems {
  const sorted: SortedProblems = { flow: [], steps: new Map() };
  for (const problem of problems) {
    if (typeof problem.step === 'number') {
      sorted.steps.set(problem.step, [...(sorted.steps.get(problem.step) ?? []), problem]);
    } else {
      sorted.flow.push(problem);
    }
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Editing a flow: open the form prefilled from a stored one
// ---------------------------------------------------------------------------

export interface StoredFlowSource {
  configuration: {
    label: string;
    description?: string | null;
    software_version?: {
      id: string;
      version_id?: string | null;
      software?: { id: string; label?: string | null } | null;
    } | null;
    inputs: {
      is_optional?: boolean | null;
      input: {
        id: string;
        label?: string | null;
        has_format?: string | null;
        position?: number | null;
        presentations: {
          presentation: { standard_variable?: { id: string; label?: string | null } | null };
        }[];
      };
    }[];
    outputs: {
      output: { id: string; label?: string | null; has_format?: string | null };
    }[];
    parameters: { parameter: { id: string; label?: string | null } }[];
  };
  flow: {
    thread_bindings_json?: unknown;
    outputs_json?: unknown;
    steps: {
      position: number;
      etl_process_id?: string | null;
      settings_json?: unknown;
      wires_json?: unknown;
      pause_after?: boolean | null;
      etl_process?: Pick<FlowPieceRow, 'id'> | null;
    }[];
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function plainKey(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .trim()
      .replace(/[^A-Za-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'input';
  const start = /^[A-Za-z]/.test(base) ? base : `in_${base}`;
  let key = start;
  for (let n = 2; taken.has(key); n += 1) key = `${start}_${n}`;
  return key;
}

/**
 * A draft that equals a stored flow, to save as a new configuration under the same
 * version: the flow's ids become the plain keys and setting names the form uses.
 * The old flow is not touched; its owner deletes it when they choose to.
 */
export function draftFromStoredFlow(stored: StoredFlowSource): FlowDraft {
  const { configuration, flow } = stored;
  const version = configuration.software_version;
  const taken = new Set<string>();
  const keyOf = new Map<string, string>();
  const inputs: DraftInput[] = [...configuration.inputs]
    .sort((a, b) => (a.input.position ?? 0) - (b.input.position ?? 0))
    .map((row) => {
      const key = plainKey(row.input.label ?? '', taken);
      taken.add(key);
      keyOf.set(row.input.id, key);
      const variable = row.input.presentations[0]?.presentation.standard_variable;
      return {
        key,
        label: row.input.label ?? key,
        standardVariable: variable?.id ?? '',
        standardVariableLabel: variable?.label ?? variable?.id ?? '',
        format: row.input.has_format ?? '',
        optional: row.is_optional === true,
      };
    });
  const settingOf = new Map(
    configuration.parameters.map((row) => [row.parameter.id, row.parameter.label ?? '']),
  );

  const steps: DraftStep[] = [...flow.steps]
    .sort((a, b) => a.position - b.position)
    .map((step) => ({
      pieceId: step.etl_process_id ?? '',
      settings: Object.fromEntries(parseSettings(step.settings_json)),
      pauseAfter: step.pause_after === true,
      wires: parseWires(step.wires_json).map((wire) => ({
        to: { ...wire.to },
        from: {
          ...wire.from,
          ...(wire.from.flow_input !== undefined
            ? { flow_input: keyOf.get(wire.from.flow_input) ?? wire.from.flow_input }
            : {}),
        },
      })),
    }));

  const outputRows = new Map(configuration.outputs.map((row) => [row.output.id, row.output]));
  const outputs: DraftOutput[] = [];
  for (const raw of Array.isArray(flow.outputs_json) ? flow.outputs_json : []) {
    if (!isRecord(raw) || typeof raw.step !== 'number') continue;
    if (typeof raw.output === 'number') {
      const row = typeof raw.output_id === 'string' ? outputRows.get(raw.output_id) : undefined;
      outputs.push({
        step: raw.step,
        kind: 'output',
        ref: String(raw.output),
        label: row?.label ?? '',
        format: row?.has_format ?? '',
        ...(isRecord(raw.editable) ? { editable: raw.editable as Json } : {}),
      });
    } else if (typeof raw.value === 'string') {
      outputs.push({ step: raw.step, kind: 'value', ref: raw.value, label: '', format: '' });
    } else if (typeof raw.record === 'string') {
      outputs.push({ step: raw.step, kind: 'record', ref: raw.record, label: '', format: '' });
    }
  }

  const bindings: DraftBindings = { region: '', start_date: '', end_date: '', collections: [] };
  const stored_ = isRecord(flow.thread_bindings_json) ? flow.thread_bindings_json : {};
  for (const role of BINDING_ROLES) {
    const target = stored_[role];
    if (!isRecord(target)) continue;
    if (typeof target.input === 'string') {
      bindings[role] = `input:${keyOf.get(target.input) ?? target.input}`;
    } else if (typeof target.parameter === 'string') {
      bindings[role] = `setting:${settingOf.get(target.parameter) ?? target.parameter}`;
    }
  }
  if (Array.isArray(stored_.collections)) {
    bindings.collections = stored_.collections.flatMap((id) =>
      typeof id === 'string' ? [keyOf.get(id) ?? id] : [],
    );
  }

  return {
    software: { id: version?.software?.id ?? '', label: version?.software?.label ?? '' },
    version: { id: version?.id ?? '', label: version?.version_id ?? '' },
    configuration: {
      label: `${configuration.label} (copy)`,
      description: configuration.description ?? '',
    },
    inputs,
    steps,
    outputs,
    bindings,
  };
}
