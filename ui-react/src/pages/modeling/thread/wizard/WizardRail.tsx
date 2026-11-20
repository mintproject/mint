import { cn } from '@/lib/utils';
import type { StepStateMap } from './deriveStepStates';
import { WIZARD_STEPS, type StepStatus, type WizardStep, type WizardStepId } from './types';

/** Everything a step list needs; MintThread is the single source of these. */
export interface ThreadStepNav {
  states: StepStateMap;
  currentStep: WizardStepId;
  onSelect: (step: WizardStepId) => void;
}

type WizardRailProps = ThreadStepNav;

const GLYPH: Record<StepStatus | 'active', string> = {
  done: '✓',
  active: '●',
  upcoming: '○',
  locked: '🔒',
};

/** One step row (glyph, label, summary). Shared by the rail and the task tree. */
export function WizardStepButton({
  step,
  states,
  currentStep,
  onSelect,
}: ThreadStepNav & { step: WizardStep }) {
  const st = states[step.id];
  const isActive = step.id === currentStep;
  const glyph = isActive ? GLYPH.active : GLYPH[st.status];

  return (
    <button
      type="button"
      data-testid={`rail-step-${step.id}`}
      aria-current={isActive ? 'step' : undefined}
      disabled={st.locked}
      onClick={() => !st.locked && onSelect(step.id)}
      className={cn(
        'flex min-w-0 items-start gap-2 px-3 py-2 text-left transition-colors',
        isActive && 'bg-accent/60 font-medium text-accent-foreground',
        !isActive && st.status === 'done' && 'text-gray-800 hover:bg-muted/40',
        !isActive && st.status === 'upcoming' && 'text-gray-700 hover:bg-muted/40',
        !isActive && st.locked && 'cursor-not-allowed text-gray-300',
      )}
    >
      <span
        className={cn(
          'mt-0.5 shrink-0 text-sm font-bold',
          !isActive && st.status === 'done' && 'text-green-600',
        )}
        aria-hidden
      >
        {glyph}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{step.label}</span>
        <span
          className={cn(
            'block truncate text-xs',
            isActive ? 'text-accent-foreground/70' : 'text-gray-400',
          )}
        >
          {st.summary}
        </span>
      </span>
    </button>
  );
}

export function WizardRail({ states, currentStep, onSelect }: WizardRailProps) {
  return (
    <details open className="mt-2">
      <summary
        data-testid="subtask-steps-toggle"
        className="flex cursor-pointer list-none items-center justify-between gap-3 border-y border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 [&::-webkit-details-marker]:hidden"
      >
        <span>Sub-task steps</span>
        <span className="truncate text-xs font-normal text-gray-500">
          Current: {WIZARD_STEPS.find((step) => step.id === currentStep)?.label ?? currentStep}
        </span>
      </summary>
      <nav aria-label="Sub-task steps" className="grid gap-1 py-2">
        {WIZARD_STEPS.map((step) => (
          <WizardStepButton
            key={step.id}
            step={step}
            states={states}
            currentStep={currentStep}
            onSelect={onSelect}
          />
        ))}
      </nav>
    </details>
  );
}
