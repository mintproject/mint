/**
 * ModelGroupList — the middle-column browse list.
 *
 * Renders Model (accordion group, expand/collapse only) -> Configuration
 * (+ version badge, dimmed when synthesized) -> Setups nested beneath. Selecting
 * a configuration or setup navigates to `${basePath}/:slug`.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { slugFromUri } from '@/lib/uri';
import { Badge } from '@/components/ui/badge';
import { FlowBadge } from '@/components/common/FlowBadge';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import type { ConfigNode, ModelGroup, SetupNode } from '@/lib/groupConfigurations';

export interface ModelGroupListProps {
  groups: ModelGroup[];
  /** Slug (trailing URI segment) of the currently selected config/setup. */
  selectedSlug: string | null;
  /** Expand every group (used while a search/facet filter is active). */
  expandAll: boolean;
  /** Route prefix for row links (the slug is appended). */
  basePath?: string;
  /** IDs owned by the current authenticated user. */
  ownedIds?: ReadonlySet<string>;
  /** IDs of configurations that are flows; they get a "Flow" badge. */
  flowIds?: ReadonlySet<string>;
  /** Empty-state copy for filtered views. */
  emptyMessage?: string;
}

export function ModelGroupList({
  groups,
  selectedSlug,
  expandAll,
  basePath = '/modelconfigurations',
  ownedIds,
  flowIds,
  emptyMessage = 'No models match your filters.',
}: ModelGroupListProps) {
  const signature = groups.map((g) => g.softwareId).join('|');
  const [open, setOpen] = useState<string[]>([]);

  // Reset expansion whenever the result set or filter mode changes.
  useEffect(() => {
    setOpen(expandAll ? groups.map((g) => g.softwareId) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandAll, signature]);

  if (groups.length === 0) {
    return <p className="px-1 py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <Accordion type="multiple" value={open} onValueChange={setOpen} className="w-full">
      {groups.map((group) => (
        <AccordionItem key={group.softwareId} value={group.softwareId} className="border-b-0">
          <AccordionTrigger className="py-2 text-sm font-semibold hover:no-underline">
            <span className="truncate text-left">{group.softwareLabel}</span>
          </AccordionTrigger>
          <AccordionContent className="pb-1">
            <div className="flex flex-col gap-0.5">
              {group.configs.map((config) => (
                <ConfigBlock
                  key={config.id}
                  config={config}
                  selectedSlug={selectedSlug}
                  basePath={basePath}
                  isOwned={ownedIds?.has(config.id) ?? false}
                  isFlow={flowIds?.has(config.id) ?? false}
                />
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

function ConfigBlock({
  config,
  selectedSlug,
  basePath,
  isOwned,
  isFlow,
}: {
  config: ConfigNode;
  selectedSlug: string | null;
  basePath: string;
  isOwned: boolean;
  isFlow: boolean;
}) {
  return (
    <div>
      <RowLink
        id={config.id}
        selectedSlug={selectedSlug}
        basePath={basePath}
        dimmed={config.synthesized}
      >
        <span className="truncate">{config.label}</span>
        {isFlow && <FlowBadge />}
        {isOwned && (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            Yours
          </Badge>
        )}
        {config.versionId && (
          <Badge variant="outline" className="ml-auto shrink-0 text-[10px]">
            {config.versionId}
          </Badge>
        )}
      </RowLink>
      {config.setups.length > 0 && (
        <div className="ml-3 flex flex-col gap-0.5 border-l pl-2">
          {config.setups.map((setup) => (
            <SetupRow
              key={setup.id}
              setup={setup}
              selectedSlug={selectedSlug}
              basePath={basePath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SetupRow({
  setup,
  selectedSlug,
  basePath,
}: {
  setup: SetupNode;
  selectedSlug: string | null;
  basePath: string;
}) {
  return (
    <RowLink id={setup.id} selectedSlug={selectedSlug} basePath={basePath}>
      <span className="truncate text-muted-foreground">{setup.label}</span>
    </RowLink>
  );
}

function RowLink({
  id,
  selectedSlug,
  basePath,
  dimmed,
  children,
}: {
  id: string;
  selectedSlug: string | null;
  basePath: string;
  dimmed?: boolean;
  children: React.ReactNode;
}) {
  const slug = slugFromUri(id);
  return (
    <Link
      to={`${basePath}/${slug}`}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent',
        slug === selectedSlug && 'bg-accent font-medium',
        dimmed && 'italic text-muted-foreground/70',
      )}
    >
      {children}
    </Link>
  );
}
