import { useState } from 'react';

import { humanizeName, type RunParam } from '@/lib/modeling/run-settings';

const SAME_FOR_EVERY_RUN_LIMIT = 6;

/** The settings every listed run shares, summarised once above a table. */
export function SameForEveryRun({
  items,
  testId,
}: {
  items: Array<{ param: RunParam; value: string }>;
  testId: string;
}) {
  const [showAll, setShowAll] = useState(false);
  if (items.length === 0) return null;
  const truncated = items.length > SAME_FOR_EVERY_RUN_LIMIT && !showAll;
  const shown = truncated ? items.slice(0, SAME_FOR_EVERY_RUN_LIMIT) : items;
  return (
    <p className="break-words text-xs text-gray-600" data-testid={testId}>
      <span className="font-medium">Same for every run:</span>{' '}
      {shown.map(({ param, value }, i) => (
        <span key={param.id ?? i}>
          {i > 0 && ' · '}
          {humanizeName(param.name)} <span className="text-gray-900">{value}</span>
        </span>
      ))}
      {items.length > SAME_FOR_EVERY_RUN_LIMIT && (
        <>
          {' '}
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-blue-600 hover:underline"
          >
            {showAll ? 'show fewer' : `show all ${items.length}`}
          </button>
        </>
      )}
    </p>
  );
}
