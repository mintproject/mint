import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface CollapsibleCardProps {
  /** The header's left side: what the card is about. */
  title: ReactNode;
  /** The header's right side: status and a short fact such as the duration. */
  summary?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A card whose header minimises it. The header is one button (`aria-expanded`),
 * and the body slides closed with a height-and-opacity animation, the one the
 * thread rail's sub-task list uses (Radix Accordion), switched off for people
 * who ask for reduced motion. The body is unmounted while closed, so anything it
 * loads is loaded only once the card is open.
 */
export function CollapsibleCard({
  title,
  summary,
  open,
  onOpenChange,
  testId,
  className,
  children,
}: CollapsibleCardProps) {
  return (
    <AccordionPrimitive.Root
      type="single"
      collapsible
      value={open ? 'card' : ''}
      onValueChange={(value) => onOpenChange(value === 'card')}
      className={cn('overflow-hidden rounded-md border border-gray-200 bg-white', className)}
      data-testid={testId}
    >
      <AccordionPrimitive.Item value="card">
        <AccordionPrimitive.Header className="flex">
          <AccordionPrimitive.Trigger className="group/card flex w-full items-center gap-2 bg-gray-50 px-3 py-2 text-left hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-gray-500 transition-transform duration-200 group-data-[state=open]/card:rotate-90 motion-reduce:transition-none"
            />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900">
              {title}
            </span>
            {summary && (
              <span className="flex shrink-0 items-center gap-2 text-xs text-gray-600">
                {summary}
              </span>
            )}
          </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>
        <AccordionPrimitive.Content className="overflow-hidden data-[state=closed]:animate-card-up data-[state=open]:animate-card-down motion-reduce:animate-none">
          <div className="space-y-3 border-t border-gray-200 px-3 py-3">{children}</div>
        </AccordionPrimitive.Content>
      </AccordionPrimitive.Item>
    </AccordionPrimitive.Root>
  );
}
