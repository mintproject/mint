import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronRight } from 'lucide-react';

import { WIZARD_STEPS } from './types';
import { WizardStepButton, type ThreadStepNav } from './WizardRail';

/**
 * The open sub-task's steps, nested under its row in the problem-statement
 * task tree. Same states and rows as WizardRail; collapsible, open by default.
 */
export function SubTaskStepsTree({ states, currentStep, onSelect }: ThreadStepNav) {
  const currentLabel = WIZARD_STEPS.find((step) => step.id === currentStep)?.label ?? currentStep;

  return (
    <AccordionPrimitive.Root type="single" collapsible defaultValue="steps">
      <AccordionPrimitive.Item value="steps">
        <AccordionPrimitive.Trigger
          data-testid="subtask-steps-toggle"
          className="group/steps flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]/steps:rotate-90 motion-reduce:transition-none" />
          <span>Steps</span>
          <span className="ml-auto truncate font-normal">Current: {currentLabel}</span>
        </AccordionPrimitive.Trigger>
        <AccordionPrimitive.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down motion-reduce:animate-none">
          <nav aria-label="Sub-task steps" className="grid gap-0.5 pb-1">
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
        </AccordionPrimitive.Content>
      </AccordionPrimitive.Item>
    </AccordionPrimitive.Root>
  );
}
