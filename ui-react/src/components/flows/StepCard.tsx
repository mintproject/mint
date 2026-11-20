/**
 * One step of the flow form: its piece, a source for each input, the flow's
 * defaults for its settings, and the problems the check found on it.
 *
 * What a piece takes and returns comes from the adapter's check (`pieces`), so
 * the slots are exactly the ones the check will test. A problem is shown on the
 * link it names (`wire` is an index into this step's wires) or, when it names no
 * link, on the step.
 */
import { Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingInput } from '@/components/common/SettingInput';
import type { PieceSummary } from '@/lib/flow-authoring-api';
import {
  EDIT_CHECKS,
  inputWireIndex,
  type DraftInput,
  type EditableChoice,
  type DraftStep,
  type FlowProblem,
} from '@/lib/flow-authoring';
import {
  settingText,
  settingTitle,
  visibilityOf,
  type SettingRule,
  type Visibility,
} from '@/lib/flow-settings';
import { describeWire, parseWires, type FlowLabels } from '@/lib/flow-steps';

import { ProposalList, type ProposalListProps } from './ProposalList';

export type SlotKey = string;
export const slotKey = (kind: 'in' | 'out', step: number, position: number): SlotKey =>
  `${kind}:${step}:${position}`;

export interface StepCardProps {
  position: number;
  step: DraftStep;
  label: string;
  summary: PieceSummary | undefined;
  flowInputs: DraftInput[];
  /** Earlier steps and what each returns, for the source choices. */
  earlier: { position: number; label: string; outputs: number[] }[];
  labels: FlowLabels;
  problems: FlowProblem[];
  suggestion: { slot: SlotKey; result: ProposalListProps['result'] } | null;
  proposalProps: Pick<ProposalListProps, 'pieceLabel' | 'sourceLabel'> &
    Partial<Omit<ProposalListProps, 'kind' | 'result'>>;
  onSource: (inputPosition: number, value: string) => void;
  onSuggestInput: (inputPosition: number) => void;
  onSuggestNext: (outputPosition: number) => void;
  onSetting: (name: string, value: string) => void;
  /** What the author decided about each setting of the flow, by name. */
  rules: Record<string, SettingRule>;
  onRule: (name: string, rule: SettingRule) => void;
  onRemoveWire: (wireIndex: number) => void;
  onPause: (pause: boolean) => void;
  /** The file this step's pause makes editable, and the change of it (`null` clears). */
  editable: EditableChoice | null;
  onEditable: (choice: EditableChoice | null) => void;
  /** What stops this pause being saved yet, found in the form. */
  pauseProblems: FlowProblem[];
  onRemove: () => void;
}

const field =
  'rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const tail = (uri?: string) =>
  uri ? (uri.split(/[/#]/).filter(Boolean).pop() ?? uri) : 'anything';

export function sourceValue(wire: { from: Record<string, unknown> } | undefined): string {
  if (!wire) return '';
  if (typeof wire.from.flow_input === 'string') return `flow:${wire.from.flow_input}`;
  if (typeof wire.from.step === 'number' && typeof wire.from.output === 'number') {
    return `step:${wire.from.step}:${wire.from.output}`;
  }
  return '';
}

export function StepCard(props: StepCardProps) {
  const { position, step, summary, problems } = props;
  const choice: EditableChoice = props.editable ?? { ref: '', file: '', check: '', key: '' };
  const wires = parseWires(step.wires);
  const onWire = (index: number) => problems.filter((problem) => problem.wire === index);
  const onStep = problems.filter((problem) => problem.wire === undefined);
  const slots = summary?.inputs ?? [];
  const slotted = new Set(slots.map((slot) => inputWireIndex(step, slot)).filter((i) => i >= 0));
  const settingWired = new Set(
    step.wires.flatMap((wire) => (typeof wire.to.setting === 'string' ? [wire.to.setting] : [])),
  );

  return (
    <li
      className="rounded border px-3 py-2"
      data-testid={`flow-form-step-${position}`}
      aria-label={`Step ${position}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">
          {position}. {props.label}
        </h4>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove step ${position}`}
          onClick={props.onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {onStep.map((problem, index) => (
        <p key={index} role="alert" className="mt-1 text-xs text-destructive">
          {problem.message}
        </p>
      ))}
      {!summary && <p className="mt-1 text-xs text-muted-foreground">Reading the piece…</p>}

      {slots.map((slot) => {
        const index = inputWireIndex(step, slot);
        const wire = index >= 0 ? step.wires[index] : undefined;
        const contract = summary?.input_contracts[String(slot)];
        const key = slotKey('in', position, slot);
        return (
          <div key={slot} className="mt-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <label
                className="min-w-[8rem] text-xs font-medium"
                htmlFor={`src-${position}-${slot}`}
              >
                Input {slot}{' '}
                <span className="font-normal text-muted-foreground">
                  ({tail(contract?.standard_variable_uri)}
                  {contract?.format ? `, ${contract.format}` : ''})
                </span>
              </label>
              <select
                id={`src-${position}-${slot}`}
                className={field}
                aria-label={`Source of input ${slot} of step ${position}`}
                value={sourceValue(wire)}
                onChange={(event) => props.onSource(slot, event.target.value)}
              >
                <option value="">Not linked</option>
                {props.flowInputs.map((input) => (
                  <option key={input.key} value={`flow:${input.key}`}>
                    Flow input: {input.label || input.key}
                  </option>
                ))}
                {props.earlier.flatMap((other) =>
                  other.outputs.map((output) => (
                    <option
                      key={`${other.position}:${output}`}
                      value={`step:${other.position}:${output}`}
                    >
                      Step {other.position} ({other.label}), output {output}
                    </option>
                  )),
                )}
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Suggest sources for step ${position} input ${slot}`}
                onClick={() => props.onSuggestInput(slot)}
              >
                Suggest
              </Button>
            </div>
            {index >= 0 &&
              onWire(index).map((problem, at) => (
                <p key={at} role="alert" className="ml-1 mt-1 text-xs text-destructive">
                  {problem.message}
                </p>
              ))}
            {props.suggestion?.slot === key && (
              <ProposalList
                kind="input"
                result={props.suggestion.result}
                {...props.proposalProps}
              />
            )}
          </div>
        );
      })}

      {wires.map((wire, index) =>
        slotted.has(index) ? null : (
          <div key={index} className="mt-1 text-xs text-muted-foreground">
            {describeWire(wire, props.labels)}{' '}
            <button
              type="button"
              className="underline"
              aria-label={`Remove link ${index + 1} of step ${position}`}
              onClick={() => props.onRemoveWire(index)}
            >
              remove
            </button>
            {onWire(index).map((problem, at) => (
              <p key={at} role="alert" className="text-destructive">
                {problem.message}
              </p>
            ))}
          </div>
        ),
      )}

      {summary && summary.settings.length > 0 && (
        <fieldset className="mt-2">
          <legend className="text-xs font-medium text-muted-foreground">
            Settings. The value is the flow&apos;s default, which a runner can change, unless you
            fix it. The model that runs this flow must accept a default.
          </legend>
          {summary.settings.map((name) => {
            const details = summary.setting_details[name];
            const wired = settingWired.has(name);
            const rule = props.rules[name];
            const fixed = rule?.fixed === true;
            const shown = visibilityOf(rule, details);
            const title = settingTitle(name, details);
            return (
              <div key={name} className="mt-2 text-sm" data-testid={`setting-${position}-${name}`}>
                <div className="flex flex-wrap items-start gap-2">
                  <label className="min-w-[8rem] pt-1 text-xs" htmlFor={`set-${position}-${name}`}>
                    {title}
                  </label>
                  <div className="min-w-[10rem] max-w-xs flex-1">
                    <SettingInput
                      id={`set-${position}-${name}`}
                      name={`set-${position}-${name}`}
                      data-testid={`set-${position}-${name}`}
                      details={details}
                      value={step.settings[name] ?? ''}
                      onChange={(value) => props.onSetting(name, value)}
                      disabled={wired}
                      unsetLabel={
                        details?.default === undefined
                          ? 'Not set'
                          : `Piece default: ${settingText(details.default)}`
                      }
                      className="h-8"
                    />
                  </div>
                  {wired ? (
                    <span className="text-xs text-muted-foreground">
                      linked to an earlier step; it cannot also have a default
                    </span>
                  ) : (
                    <>
                      <select
                        className={field}
                        aria-label={`Is the value of ${title} a default or fixed`}
                        value={fixed ? 'fixed' : 'default'}
                        onChange={(event) =>
                          props.onRule(name, { ...rule, fixed: event.target.value === 'fixed' })
                        }
                      >
                        <option value="default">Default: a runner can change it</option>
                        <option value="fixed">Fixed: a runner cannot change it</option>
                      </select>
                      <select
                        className={field}
                        aria-label={`Who sees ${title}`}
                        value={shown}
                        onChange={(event) =>
                          props.onRule(name, {
                            ...rule,
                            visibility: event.target.value as Visibility,
                          })
                        }
                      >
                        <option value="shown">Shown</option>
                        <option value="advanced">Advanced settings</option>
                        <option value="hidden">Hidden from runners</option>
                      </select>
                    </>
                  )}
                </div>
                {details?.description && (
                  <p className="ml-1 mt-0.5 text-xs text-muted-foreground">{details.description}</p>
                )}
              </div>
            );
          })}
        </fieldset>
      )}

      {summary && summary.outputs.length > 0 && (
        <div className="mt-2 text-xs">
          {summary.outputs.map((output) => {
            const key = slotKey('out', position, output);
            return (
              <div key={output} className="mt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Suggest next steps from step ${position} output ${output}`}
                  onClick={() => props.onSuggestNext(output)}
                >
                  What can take output {output}?
                </Button>
                {props.suggestion?.slot === key && (
                  <ProposalList
                    kind="output"
                    result={props.suggestion.result}
                    {...props.proposalProps}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <label className="mt-2 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={step.pauseAfter}
          onChange={(event) => props.onPause(event.target.checked)}
        />
        Pause for review after this step
      </label>

      {step.pauseAfter && (
        <fieldset className="mt-2 text-xs" aria-label={`Editable file of step ${position}`}>
          <legend className="font-medium">File the person edits at this pause</legend>
          {summary && summary.outputs.length === 0 ? (
            <p className="mt-1 text-muted-foreground">This step returns no file to edit.</p>
          ) : (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <select
                className={field}
                aria-label={`Editable output of step ${position}`}
                value={choice.ref}
                onChange={(event) => props.onEditable({ ...choice, ref: event.target.value })}
              >
                <option value="">Choose an output…</option>
                {(summary?.outputs ?? []).map((output) => (
                  <option key={output} value={String(output)}>
                    Output {output}
                  </option>
                ))}
              </select>
              <Input
                className="h-8 w-48"
                aria-label={`File name to edit for step ${position}`}
                placeholder="lexicon_draft.json"
                value={choice.file}
                disabled={choice.ref === ''}
                onChange={(event) => props.onEditable({ ...choice, file: event.target.value })}
              />
              <select
                className={field}
                aria-label={`Check on the edited file of step ${position}`}
                value={choice.check}
                disabled={choice.ref === ''}
                onChange={(event) => props.onEditable({ ...choice, check: event.target.value })}
              >
                <option value="">No check</option>
                {EDIT_CHECKS.map((check) => (
                  <option key={check} value={check}>
                    {check}
                  </option>
                ))}
              </select>
              <Input
                className="h-8 w-40"
                aria-label={`Key of the edited file of step ${position}`}
                placeholder="Key (optional)"
                value={choice.key}
                disabled={choice.ref === ''}
                onChange={(event) => props.onEditable({ ...choice, key: event.target.value })}
              />
            </div>
          )}
          {props.pauseProblems.map((problem, index) => (
            <p key={index} role="alert" className="mt-1 text-destructive">
              {problem.message}
            </p>
          ))}
        </fieldset>
      )}
    </li>
  );
}
