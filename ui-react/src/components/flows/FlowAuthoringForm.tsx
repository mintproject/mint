/**
 * FlowAuthoringForm — build a flow of ETL pieces and save it as a model.
 *
 * A form, not a canvas: the form is the source of truth and the graph below it is
 * read-only. Every change is checked by the adapter (`POST /flows/check`), the
 * problems appear on the step and link they are on, and Save stays off until the
 * check passes for exactly what is in the form. Save is `POST /flows` on the model
 * catalog API, which checks again and writes as the signed-in user.
 *
 * A flow never changes in place. Opened from an existing flow, the form is
 * prefilled and Save writes a NEW configuration under the same version; the old
 * one stays until its owner deletes it.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trash2 } from 'lucide-react';

import { StandardVariableCombobox } from '@/components/autocomplete/StandardVariableCombobox';
import { WorkflowCanvas } from '@/components/modeling/WorkflowCanvas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PickerPiece } from '@/graphql/queries/flow-authoring';
import {
  MAX_STEPS,
  addStep,
  applyChain,
  applyDirect,
  applyNext,
  applyProduces,
  buildCheckBody,
  buildSaveBody,
  editableChoice,
  emptyDraft,
  pauseProblems,
  removeInput,
  removeStep,
  removeWire,
  setEditable,
  setInputWire,
  setPause,
  sortProblems,
  updateStep,
  type BindingRole,
  type DraftOutput,
  type FlowDraft,
  type ProposedSource,
} from '@/lib/flow-authoring';
import {
  checkFlow,
  proposeForFlow,
  saveFlow,
  type FlowCheck,
  type PieceSummary,
  type ProposeResult,
  type Purpose,
  type SaveResult,
} from '@/lib/flow-authoring-api';
import { applyRoute } from '@/lib/flow-routes';
import { FLOW_LAYOUT_OPTIONS, flowCanvasHeight } from '@/lib/flow-graph-layout';
import { flowStepsGraph, type FlowLabels } from '@/lib/flow-steps';
import { slugFromUri } from '@/lib/uri';

import { CloseVariableProposals } from './CloseVariableProposals';
import { DescribeStepSearch } from './DescribeStepSearch';
import { ProposalList } from './ProposalList';
import { StepCard, slotKey, type SlotKey } from './StepCard';

export interface FlowAuthoringFormProps {
  /** A flow to start from (a copy of an existing one), or none for a new flow. */
  initial?: FlowDraft;
  /** The pieces the signed-in user may see. */
  pieces: PickerPiece[];
  token: string | null;
  /** Wait before a change is checked or a description searched. Tests set 0. */
  checkDelayMs?: number;
}

const field =
  'rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const heading = 'mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground';

type Suggestion = { slot: SlotKey; result: ProposeResult | 'loading' };

export function FlowAuthoringForm({
  initial,
  pieces,
  token,
  checkDelayMs = 350,
}: FlowAuthoringFormProps) {
  const [draft, setDraft] = useState<FlowDraft>(() => initial ?? emptyDraft());
  const [checked, setChecked] = useState<{ key: string; check: FlowCheck | null } | null>(null);
  const [summaries, setSummaries] = useState<Record<string, PieceSummary>>({});
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [nextPiece, setNextPiece] = useState('');
  const [wanted, setWanted] = useState<{ id: string; label: string } | null>(null);
  const [wantedFormat, setWantedFormat] = useState('');
  const [output, setOutput] = useState<{ step: string; kind: DraftOutput['kind']; ref: string }>({
    step: '1',
    kind: 'output',
    ref: '1',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SaveResult | null>(null);

  const pieceLabel = useMemo(() => {
    const labels = new Map(pieces.map((piece) => [piece.id, piece.label?.trim() || piece.id]));
    return (id: string) => labels.get(id) ?? 'a piece you cannot see';
  }, [pieces]);

  // --- the live check ---------------------------------------------------------
  const body = useMemo(() => buildCheckBody(draft), [draft]);
  const bodyKey = JSON.stringify(body);
  useEffect(() => {
    if (!token || draft.steps.length === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void checkFlow(body, token, controller.signal).then((check) => {
        if (controller.signal.aborted) return;
        setChecked({ key: bodyKey, check });
        if (check) setSummaries((known) => ({ ...known, ...check.pieces }));
      });
    }, checkDelayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `body` is derived from `bodyKey`'s draft; the key is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyKey, token, checkDelayMs]);

  const current = checked?.key === bodyKey ? checked.check : null;
  const sorted = useMemo(() => sortProblems(current?.problems ?? []), [current]);

  const change = (next: FlowDraft) => {
    setDraft(next);
    setSuggestion(null);
    setSaved(null);
  };

  // --- proposals --------------------------------------------------------------
  const ask = async (slot: SlotKey, purpose: Purpose, snapshot: FlowDraft) => {
    setSuggestion({ slot, result: 'loading' });
    const result = token
      ? await proposeForFlow(buildCheckBody(snapshot), purpose, token)
      : { error: 'Sign in to get proposals.' };
    setSuggestion({ slot, result });
  };

  const sourceLabel = (source: ProposedSource): string => {
    if (source.kind === 'flow_input') {
      const input = draft.inputs.find((item) => item.key === source.id);
      return `flow input ${input?.label || source.id}`;
    }
    const piece = draft.steps[(source.step ?? 1) - 1]?.pieceId;
    return `step ${source.step} (${piece ? pieceLabel(piece) : '?'}), output ${source.output}`;
  };
  const proposalProps = { pieceLabel, sourceLabel };

  const labels = useMemo<FlowLabels>(
    () => ({
      inputs: new Map(draft.inputs.map((input) => [input.key, input.label || input.key])),
      parameters: new Map(),
    }),
    [draft.inputs],
  );

  // --- the read-only graph ----------------------------------------------------
  const graph = useMemo(
    () =>
      flowStepsGraph(
        draft.steps.map((step, index) => ({
          position: index + 1,
          etl_process_id: step.pieceId,
          wires_json: step.wires,
          settings_json: step.settings,
          etl_process: { id: step.pieceId, label: pieceLabel(step.pieceId) },
        })),
        labels,
      ),
    [draft.steps, labels, pieceLabel],
  );

  const settingNames = useMemo(
    () =>
      [...new Set(draft.steps.flatMap((step) => summaries[step.pieceId]?.settings ?? []))].sort(),
    [draft.steps, summaries],
  );

  // --- save -------------------------------------------------------------------
  const pausing = useMemo(() => pauseProblems(draft), [draft]);
  const complete =
    draft.configuration.label.trim() !== '' &&
    (draft.software.id !== '' || draft.software.label.trim() !== '') &&
    (draft.version.id !== '' || draft.version.label.trim() !== '') &&
    draft.inputs.every((input) => input.key !== '' && input.standardVariable !== '') &&
    draft.outputs.every((item) => item.kind !== 'output' || item.label.trim() !== '') &&
    pausing.length === 0;
  const canSave = Boolean(token) && !saving && complete && current?.ok === true;

  const save = async () => {
    if (!token || !canSave) return;
    setSaving(true);
    setSaved(await saveFlow(buildSaveBody(draft), token));
    setSaving(false);
  };

  const stepOutputs = (index: number) =>
    summaries[draft.steps[index]?.pieceId ?? '']?.outputs ?? [];
  const chosenStep = Number(output.step);
  const chosenSummary = summaries[draft.steps[chosenStep - 1]?.pieceId ?? ''];

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <section aria-label="About the flow" className="space-y-2">
        <h3 className={heading}>About</h3>
        <label className="block text-sm">
          Name
          <Input
            aria-label="Flow name"
            value={draft.configuration.label}
            onChange={(e) =>
              change({ ...draft, configuration: { ...draft.configuration, label: e.target.value } })
            }
          />
        </label>
        <label className="block text-sm">
          Description
          <Input
            aria-label="Flow description"
            value={draft.configuration.description}
            onChange={(e) =>
              change({
                ...draft,
                configuration: { ...draft.configuration, description: e.target.value },
              })
            }
          />
        </label>
        {draft.version.id ? (
          <p className="text-xs text-muted-foreground">
            Saved as a new configuration under the same version
            {draft.software.label ? ` of ${draft.software.label}` : ''}. The flow you started from
            stays until its owner deletes it.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <label className="text-sm">
              Model
              <Input
                aria-label="Model name"
                value={draft.software.label}
                onChange={(e) =>
                  change({ ...draft, software: { ...draft.software, label: e.target.value } })
                }
              />
            </label>
            <label className="text-sm">
              Version
              <Input
                aria-label="Version"
                value={draft.version.label}
                onChange={(e) =>
                  change({ ...draft, version: { ...draft.version, label: e.target.value } })
                }
              />
            </label>
          </div>
        )}
      </section>

      <section aria-label="Flow inputs">
        <h3 className={heading}>Flow inputs</h3>
        <ul className="space-y-2">
          {draft.inputs.map((input, index) => (
            <li key={index} className="rounded border p-2" data-testid={`flow-form-input-${index}`}>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs">
                  Name
                  <Input
                    className="h-8 w-32"
                    aria-label={`Input ${index + 1} name`}
                    value={input.key}
                    onChange={(e) => {
                      const key = e.target.value.replace(/[^A-Za-z0-9_]/g, '');
                      const rename = (target: string) =>
                        target === `input:${input.key}` ? `input:${key}` : target;
                      change({
                        ...draft,
                        inputs: draft.inputs.map((it, at) => (at === index ? { ...it, key } : it)),
                        steps: draft.steps.map((step) => ({
                          ...step,
                          wires: step.wires.map((wire) =>
                            wire.from.flow_input === input.key
                              ? { ...wire, from: { flow_input: key } }
                              : wire,
                          ),
                        })),
                        bindings: {
                          region: rename(draft.bindings.region),
                          start_date: rename(draft.bindings.start_date),
                          end_date: rename(draft.bindings.end_date),
                          collections: draft.bindings.collections.map((c) =>
                            c === input.key ? key : c,
                          ),
                        },
                      });
                    }}
                  />
                </label>
                <label className="text-xs">
                  Label
                  <Input
                    className="h-8 w-40"
                    aria-label={`Input ${index + 1} label`}
                    value={input.label}
                    onChange={(e) =>
                      change({
                        ...draft,
                        inputs: draft.inputs.map((it, at) =>
                          at === index ? { ...it, label: e.target.value } : it,
                        ),
                      })
                    }
                  />
                </label>
                <div className="text-xs">
                  Standard variable
                  <StandardVariableCombobox
                    value={
                      input.standardVariable
                        ? {
                            id: input.standardVariable,
                            label: input.standardVariableLabel,
                            description: null,
                          }
                        : null
                    }
                    onChange={(option) =>
                      change({
                        ...draft,
                        inputs: draft.inputs.map((it, at) =>
                          at === index
                            ? {
                                ...it,
                                standardVariable: option?.id ?? '',
                                standardVariableLabel: option?.label ?? '',
                              }
                            : it,
                        ),
                      })
                    }
                  />
                </div>
                <label className="text-xs">
                  Format
                  <Input
                    className="h-8 w-28"
                    aria-label={`Input ${index + 1} format`}
                    value={input.format}
                    onChange={(e) =>
                      change({
                        ...draft,
                        inputs: draft.inputs.map((it, at) =>
                          at === index ? { ...it, format: e.target.value } : it,
                        ),
                      })
                    }
                  />
                </label>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={input.optional}
                    onChange={(e) =>
                      change({
                        ...draft,
                        inputs: draft.inputs.map((it, at) =>
                          at === index ? { ...it, optional: e.target.checked } : it,
                        ),
                      })
                    }
                  />
                  Optional
                </label>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    aria-label={`Input ${index + 1} takes a collection of files`}
                    checked={draft.bindings.collections.includes(input.key)}
                    onChange={(e) =>
                      change({
                        ...draft,
                        bindings: {
                          ...draft.bindings,
                          collections: e.target.checked
                            ? [...draft.bindings.collections, input.key]
                            : draft.bindings.collections.filter((c) => c !== input.key),
                        },
                      })
                    }
                  />
                  Takes a collection of files
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove input ${index + 1}`}
                  onClick={() => change(removeInput(draft, input.key))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() =>
            change({
              ...draft,
              inputs: [
                ...draft.inputs,
                {
                  key: `input${draft.inputs.length + 1}`,
                  label: '',
                  standardVariable: '',
                  standardVariableLabel: '',
                  format: '',
                  optional: false,
                },
              ],
            })
          }
        >
          Add a flow input
        </Button>
      </section>

      <section aria-label="Steps">
        <h3 className={heading}>Steps ({draft.steps.length})</h3>
        {draft.steps.length === 0 && (
          <p className="mb-2 text-sm text-muted-foreground">
            A flow needs at least one step. Pick a piece to start.
          </p>
        )}
        <ol className="space-y-2">
          {draft.steps.map((step, index) => {
            const position = index + 1;
            return (
              <StepCard
                key={`${position}-${step.pieceId}`}
                position={position}
                step={step}
                label={pieceLabel(step.pieceId)}
                summary={summaries[step.pieceId]}
                flowInputs={draft.inputs}
                earlier={draft.steps.slice(0, index).map((other, at) => ({
                  position: at + 1,
                  label: pieceLabel(other.pieceId),
                  outputs: stepOutputs(at),
                }))}
                labels={labels}
                problems={sorted.steps.get(position) ?? []}
                suggestion={suggestion}
                proposalProps={{
                  ...proposalProps,
                  onDirect: (source) => {
                    if (suggestion?.slot.startsWith(`in:${position}:`)) {
                      const slot = Number(suggestion.slot.split(':')[2]);
                      change(applyDirect(draft, index, slot, source));
                    }
                  },
                  onChain: (chain) => {
                    if (suggestion?.slot.startsWith(`in:${position}:`)) {
                      const slot = Number(suggestion.slot.split(':')[2]);
                      change(applyChain(draft, index, slot, chain));
                    }
                  },
                  onNext: (next) => {
                    if (suggestion?.slot.startsWith(`out:${position}:`)) {
                      const from = {
                        step: position,
                        output: Number(suggestion.slot.split(':')[2]),
                      };
                      change(applyNext(draft, next, from));
                    }
                  },
                }}
                onSource={(inputPosition, value) => {
                  const [kind, first, second] = value.split(':');
                  const from =
                    kind === 'flow'
                      ? { flow_input: first }
                      : kind === 'step'
                        ? { step: Number(first), output: Number(second) }
                        : null;
                  change(setInputWire(draft, index, inputPosition, from));
                }}
                onSuggestInput={(inputPosition) =>
                  void ask(
                    slotKey('in', position, inputPosition),
                    { step: position, input: inputPosition },
                    draft,
                  )
                }
                onSuggestNext={(outputPosition) =>
                  void ask(
                    slotKey('out', position, outputPosition),
                    { step: position, output: outputPosition },
                    draft,
                  )
                }
                onSetting={(name, value) =>
                  change(
                    updateStep(draft, index, { settings: { ...step.settings, [name]: value } }),
                  )
                }
                onRemoveWire={(wireIndex) => change(removeWire(draft, index, wireIndex))}
                onPause={(pause) => change(setPause(draft, index, pause))}
                editable={editableChoice(draft, position)}
                onEditable={(choice) => change(setEditable(draft, position, choice))}
                pauseProblems={pausing.filter((problem) => problem.step === position)}
                onRemove={() => change(removeStep(draft, index))}
              />
            );
          })}
        </ol>
        {draft.steps.length < MAX_STEPS && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              className={field}
              aria-label="Piece for the next step"
              value={nextPiece}
              onChange={(e) => setNextPiece(e.target.value)}
            >
              <option value="">Choose a piece…</option>
              {pieces.map((piece) => (
                <option key={piece.id} value={piece.id}>
                  {piece.label?.trim() || piece.id}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!nextPiece}
              onClick={() => {
                change(addStep(draft, nextPiece));
                setNextPiece('');
              }}
            >
              Add step
            </Button>
          </div>
        )}
        {draft.steps.length < MAX_STEPS && (
          <DescribeStepSearch
            pieces={pieces}
            delayMs={checkDelayMs}
            onAdd={(pieceId) => change(addStep(draft, pieceId))}
          />
        )}
      </section>

      <section aria-label="Find a piece for a wanted result">
        <h3 className={heading}>Wanted result</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="text-xs">
            Standard variable
            <StandardVariableCombobox
              value={wanted ? { ...wanted, description: null } : null}
              onChange={(option) =>
                setWanted(option ? { id: option.id, label: option.label } : null)
              }
            />
          </div>
          <label className="text-xs">
            Format
            <Input
              className="h-8 w-28"
              aria-label="Wanted format"
              value={wantedFormat}
              onChange={(e) => setWantedFormat(e.target.value)}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!wanted}
            onClick={() =>
              void ask(
                'want',
                {
                  contract: {
                    standard_variable_uri: wanted?.id,
                    ...(wantedFormat ? { format: wantedFormat } : {}),
                  },
                },
                draft,
              )
            }
          >
            Find pieces that make it
          </Button>
        </div>
        {suggestion?.slot === 'want' && (
          <ProposalList
            kind="want"
            result={suggestion.result}
            {...proposalProps}
            wantedLabel={wanted?.label}
            onAddRoute={(entry, choice) => change(applyRoute(draft, entry, choice))}
          />
        )}
        {suggestion?.slot === 'want' &&
          wanted &&
          token &&
          typeof suggestion.result === 'object' &&
          'proposal' in suggestion.result &&
          suggestion.result.proposal.produces.length === 0 && (
            <CloseVariableProposals
              wanted={wanted}
              draft={draft}
              token={token}
              pieceLabel={pieceLabel}
              delayMs={checkDelayMs}
              onAdd={(entry) => change(applyProduces(draft, entry))}
              onWant={(variable) => {
                setWanted(variable);
                setSuggestion(null);
              }}
            />
          )}
      </section>

      <section aria-label="Flow outputs">
        <h3 className={heading}>Outputs</h3>
        <ul className="space-y-1">
          {draft.outputs.map((item, index) => (
            <li key={index} className="flex flex-wrap items-center gap-2 text-sm">
              <span>
                Step {item.step},{' '}
                {item.kind === 'output' ? `output ${item.ref}` : `${item.kind} ${item.ref}`}
              </span>
              {item.kind === 'output' && (
                <>
                  <Input
                    className="h-8 w-48"
                    aria-label={`Output ${index + 1} label`}
                    placeholder="Label"
                    value={item.label}
                    onChange={(e) =>
                      change({
                        ...draft,
                        outputs: draft.outputs.map((it, at) =>
                          at === index ? { ...it, label: e.target.value } : it,
                        ),
                      })
                    }
                  />
                  <Input
                    className="h-8 w-28"
                    aria-label={`Output ${index + 1} format`}
                    placeholder="Format"
                    value={item.format}
                    onChange={(e) =>
                      change({
                        ...draft,
                        outputs: draft.outputs.map((it, at) =>
                          at === index ? { ...it, format: e.target.value } : it,
                        ),
                      })
                    }
                  />
                </>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove output ${index + 1}`}
                onClick={() =>
                  change({ ...draft, outputs: draft.outputs.filter((_, at) => at !== index) })
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
        {draft.steps.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              className={field}
              aria-label="Step of the new output"
              value={output.step}
              onChange={(e) => setOutput({ step: e.target.value, kind: 'output', ref: '' })}
            >
              {draft.steps.map((step, index) => (
                <option key={index} value={String(index + 1)}>
                  Step {index + 1} ({pieceLabel(step.pieceId)})
                </option>
              ))}
            </select>
            <select
              className={field}
              aria-label="Kind of the new output"
              value={output.kind}
              onChange={(e) =>
                setOutput({ ...output, kind: e.target.value as DraftOutput['kind'], ref: '' })
              }
            >
              <option value="output">A dataset</option>
              <option value="value">A value</option>
              <option value="record">A published record</option>
            </select>
            {output.kind === 'record' ? (
              <Input
                className="h-8 w-40"
                aria-label="Name of the record"
                value={output.ref}
                onChange={(e) => setOutput({ ...output, ref: e.target.value })}
              />
            ) : (
              <select
                className={field}
                aria-label="Which output of the step"
                value={output.ref}
                onChange={(e) => setOutput({ ...output, ref: e.target.value })}
              >
                <option value="">Choose…</option>
                {(output.kind === 'output'
                  ? (chosenSummary?.outputs ?? []).map(String)
                  : (chosenSummary?.values ?? [])
                ).map((ref) => (
                  <option key={ref} value={ref}>
                    {ref}
                  </option>
                ))}
              </select>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={output.ref === ''}
              onClick={() => {
                change({
                  ...draft,
                  outputs: [
                    ...draft.outputs,
                    {
                      step: chosenStep,
                      kind: output.kind,
                      ref: output.ref,
                      label: output.kind === 'output' ? `Output ${draft.outputs.length + 1}` : '',
                      format: '',
                    },
                  ],
                });
                setOutput({ ...output, ref: '' });
              }}
            >
              Add output
            </Button>
          </div>
        )}
      </section>

      <section aria-label="Thread bindings">
        <h3 className={heading}>What the thread fills in</h3>
        {(
          [
            ['region', 'Region'],
            ['start_date', 'Start date'],
            ['end_date', 'End date'],
          ] as [BindingRole, string][]
        ).map(([role, name]) => (
          <label key={role} className="mb-1 flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-[6rem]">{name}</span>
            <select
              className={field}
              aria-label={`${name} is filled in by`}
              value={draft.bindings[role]}
              onChange={(e) =>
                change({ ...draft, bindings: { ...draft.bindings, [role]: e.target.value } })
              }
            >
              <option value="">Nothing</option>
              {draft.inputs.map((input) => (
                <option key={input.key} value={`input:${input.key}`}>
                  Flow input: {input.label || input.key}
                </option>
              ))}
              {settingNames.map((setting) => (
                <option key={setting} value={`setting:${setting}`}>
                  Setting: {setting}
                </option>
              ))}
            </select>
          </label>
        ))}
        <p className="text-xs text-muted-foreground">
          Which inputs take a collection of files is set on each input above.
        </p>
      </section>

      {draft.steps.length > 0 && (
        <section aria-label="Graph">
          <h3 className={heading}>Graph</h3>
          <WorkflowCanvas
            positions={graph.positions}
            edges={graph.edges}
            renderNode={(node) => (
              <div className="h-[128px] w-full overflow-hidden rounded-lg border bg-white px-3 py-2 text-sm">
                <div className="text-[10px] font-semibold uppercase opacity-70">
                  {node.kind === 'step' ? 'Step' : 'Flow input'}
                </div>
                <div className="break-words font-semibold">{node.label}</div>
              </div>
            )}
            height={flowCanvasHeight(graph.positions)}
            layoutOptions={FLOW_LAYOUT_OPTIONS}
            markerId="flow-form-arrow"
            testId="flow-form-canvas"
          />
        </section>
      )}

      <section aria-label="Check and save" className="space-y-2">
        {sorted.flow.map((problem, index) => (
          <p key={index} role="alert" className="text-sm text-destructive">
            {problem.message}
          </p>
        ))}
        {draft.steps.length > 0 && !checked && token && (
          <p className="text-sm text-muted-foreground">Checking…</p>
        )}
        {draft.steps.length > 0 && checked?.key === bodyKey && checked.check === null && (
          <p className="text-sm text-destructive">
            The check could not be run, so it cannot be saved.
          </p>
        )}
        {current?.ok && <p className="text-sm text-green-700">The flow fits its pieces.</p>}
        {saved && !saved.ok && (
          <div role="alert" className="text-sm text-destructive">
            <p>{saved.message}</p>
            {saved.problems.map((problem, index) => (
              <p key={index}>
                {problem.step ? `Step ${problem.step}: ` : ''}
                {problem.message}
              </p>
            ))}
          </div>
        )}
        {saved?.ok && (
          <p className="text-sm text-green-700">
            Saved.{' '}
            <Link
              className="underline"
              to={`/modelconfigurations/${slugFromUri(saved.configurationId)}`}
            >
              Open the new flow
            </Link>
          </p>
        )}
        <Button type="submit" disabled={!canSave}>
          {saving ? 'Saving…' : 'Save flow'}
        </Button>
      </section>
    </form>
  );
}
