import type { Execution } from '@/graphql/generated/execution';
import { settingsUsed, type RunParam } from '@/lib/modeling/run-settings';

/**
 * What one run was given: its settings, those changed from their default first.
 * Collapsed, so a run that used only defaults does not take up the page.
 */
export function SettingsUsed({
  params,
  execution,
  testId,
  summary = 'Settings used',
}: {
  params: RunParam[];
  execution: Execution | undefined;
  testId: string;
  summary?: string;
}) {
  const settings = execution ? settingsUsed(params, execution) : [];
  if (settings.length === 0) return null;
  const changed = settings.filter((s) => s.changed).length;
  return (
    <details className="text-xs text-gray-700" data-testid={testId}>
      <summary className="cursor-pointer font-medium text-gray-800">
        {summary}
        <span className="ml-1 font-normal text-gray-500">
          ({settings.length}
          {changed > 0 ? `, ${changed} changed from default` : ''})
        </span>
      </summary>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
        {settings.map((setting) => (
          <div key={setting.id} className="contents">
            <dt className="text-gray-500">
              {setting.label}
              {setting.changed && <span className="ml-1 text-blue-700">changed</span>}
            </dt>
            <dd className="break-words font-medium text-gray-900">{setting.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
