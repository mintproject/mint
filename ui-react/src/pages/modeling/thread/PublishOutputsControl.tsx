/**
 * PublishOutputsControl — optional "Publish outputs" section of the run form.
 *
 * Shown only when the Ensemble Manager offers at least one publisher for the
 * model. The user picks a catalog (one option per publisher) and the
 * publisher's user-facing parameters; the parent sends the tokens as `publish`
 * on plan creation and the values as `parameter_values` on submit.
 */
import type { PlanPublisher, UnifiedParameterDefinition } from '@/lib/ensemble-manager';
import { publisherDefaults, publisherLabel, type PublishSelection } from '@/lib/publish-outputs';

interface PublishOutputsControlProps {
  modelId: string;
  publishers: PlanPublisher[];
  selection: PublishSelection | null;
  onChange: (selection: PublishSelection | null) => void;
  disabled?: boolean;
}

function ParameterField({
  modelId,
  parameter,
  value,
  onChange,
  disabled,
}: {
  modelId: string;
  parameter: UnifiedParameterDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const testId = `publish-param-${modelId}-${parameter.name}`;
  if (parameter.allowed_values && parameter.allowed_values.length > 0) {
    return (
      <label className="flex flex-col gap-1 text-xs text-gray-700">
        <span>{parameter.name}</span>
        <select
          data-testid={testId}
          aria-label={parameter.name}
          value={value === undefined || value === null ? '' : String(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="rounded border border-gray-300 px-2 py-1.5 text-sm"
        >
          {(!parameter.required || value === undefined || value === null || value === '') && (
            <option value="">{parameter.required ? 'Select…' : '(none)'}</option>
          )}
          {parameter.allowed_values.map((allowed) => (
            <option key={String(allowed)} value={String(allowed)}>
              {String(allowed)}
            </option>
          ))}
        </select>
        {parameter.description && <span className="text-gray-500">{parameter.description}</span>}
      </label>
    );
  }
  if (parameter.type === 'boolean') {
    return (
      <label className="flex flex-col gap-1 text-xs text-gray-700">
        <span className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid={testId}
            aria-label={parameter.name}
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          {parameter.name}
        </span>
        {parameter.name === 'public' && (
          <span className="text-gray-500">The SUBSIDE map needs public assets</span>
        )}
        {parameter.description && parameter.name !== 'public' && (
          <span className="text-gray-500">{parameter.description}</span>
        )}
      </label>
    );
  }
  return (
    <label className="flex flex-col gap-1 text-xs text-gray-700">
      <span>{parameter.name}</span>
      <input
        data-testid={testId}
        aria-label={parameter.name}
        type="text"
        value={value === undefined || value === null ? '' : String(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="rounded border border-gray-300 px-2 py-1.5 text-sm"
      />
      {parameter.description && <span className="text-gray-500">{parameter.description}</span>}
    </label>
  );
}

export function PublishOutputsControl({
  modelId,
  publishers,
  selection,
  onChange,
  disabled = false,
}: PublishOutputsControlProps) {
  if (publishers.length === 0) return null;

  const selected = publishers.find((item) => item.transform_spec_id === selection?.transformSpecId);
  const firstUsable = publishers.find((item) => item.can_publish.ok);
  const blockedReason = !firstUsable ? publishers[0]?.can_publish.reason : null;
  const enabled = Boolean(selection);

  const choose = (publisher: PlanPublisher) =>
    onChange({
      transformSpecId: publisher.transform_spec_id,
      values: publisherDefaults(publisher),
    });

  return (
    <fieldset
      className="space-y-2 rounded border border-gray-200 px-3 py-2"
      data-testid={`publish-outputs-${modelId}`}
    >
      <legend className="px-1 text-xs font-semibold text-gray-700">Publish outputs</legend>
      <label className="flex items-center gap-2 text-sm text-gray-800">
        <input
          type="checkbox"
          data-testid={`publish-toggle-${modelId}`}
          checked={enabled}
          disabled={disabled || !firstUsable}
          onChange={(event) => {
            if (!event.target.checked) onChange(null);
            else if (firstUsable) choose(firstUsable);
          }}
        />
        Publish outputs
      </label>
      {!firstUsable && blockedReason && (
        <p className="text-xs text-amber-700" data-testid={`publish-blocked-${modelId}`}>
          {blockedReason}
        </p>
      )}
      {enabled && selected && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-gray-700">
            <span>Catalog</span>
            <select
              data-testid={`publish-catalog-${modelId}`}
              aria-label="Catalog"
              value={selected.transform_spec_id}
              disabled={disabled}
              onChange={(event) => {
                const next = publishers.find(
                  (item) => item.transform_spec_id === event.target.value,
                );
                if (next) choose(next);
              }}
              className="rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              {publishers.map((publisher) => (
                <option
                  key={publisher.transform_spec_id}
                  value={publisher.transform_spec_id}
                  disabled={!publisher.can_publish.ok}
                >
                  {publisherLabel(publisher)}
                  {publisher.can_publish.ok
                    ? ''
                    : ` (unavailable: ${publisher.can_publish.reason ?? 'not permitted'})`}
                </option>
              ))}
            </select>
          </label>
          {selected.parameters.map((parameter) => (
            <ParameterField
              key={parameter.name}
              modelId={modelId}
              parameter={parameter}
              value={selection?.values[parameter.name]}
              disabled={disabled}
              onChange={(value) =>
                onChange({
                  transformSpecId: selected.transform_spec_id,
                  values: { ...selection?.values, [parameter.name]: value },
                })
              }
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}
