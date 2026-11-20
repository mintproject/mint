/**
 * ConfigurationDetail — read-only view of a model configuration.
 *
 * Tabular display of inputs, outputs, parameters with an Edit button
 * that transitions to ConfigurationForm.
 */
import { ArrowUpRight, Pencil, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { useGetConfigurationQuery } from '@/graphql/generated/graphql';
import { slugFromUri } from '@/lib/uri';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { FlowStepsSection } from './FlowStepsSection';

export interface ConfigurationDetailProps {
  configurationId: string;
  onEdit?: () => void;
  onDelete?: (label: string) => void;
}

export function ConfigurationDetail({
  configurationId,
  onEdit,
  onDelete,
}: ConfigurationDetailProps) {
  const { data, loading, error } = useGetConfigurationQuery({
    variables: { id: configurationId },
    fetchPolicy: 'cache-first',
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <LoadingSpinner />
      </div>
    );
  }

  if (error || !data?.modelcatalog_configuration_by_pk) {
    return (
      <div className="p-4 text-sm text-destructive">
        {error?.message ?? 'Configuration not found.'}
      </div>
    );
  }

  const config = data.modelcatalog_configuration_by_pk;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {config.software_version?.software?.label && (
              <span className="text-xs text-muted-foreground">
                {config.software_version.software.label}
              </span>
            )}
            {config.software_version?.version_id && (
              <Badge variant="outline" className="text-[10px]">
                {config.software_version.version_id}
              </Badge>
            )}
          </div>
          <h2 className="mt-0.5 text-base font-semibold">{config.label}</h2>
          {config.description && (
            <p className="mt-1 text-sm text-muted-foreground">{config.description}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {onEdit ? (
            <Button variant="outline" size="sm" onClick={onEdit} className="gap-1.5">
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
          ) : (
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link to={`/models/configure/${slugFromUri(config.id)}`}>
                Configure
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
          {onDelete && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => onDelete(config.label)}
              className="gap-1.5"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
        </div>
      </div>

      {/* Authors */}
      {config.authors.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Authors
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {config.authors.map((a) => (
              <Badge key={a.person.id} variant="secondary">
                {a.person.label ?? a.person.id}
              </Badge>
            ))}
          </div>
        </section>
      )}

      {/* Regions */}
      {config.regions.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Regions
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {config.regions.map((r) => (
              <Badge key={r.region.id} variant="outline">
                {r.region.label ?? r.region.id}
              </Badge>
            ))}
          </div>
        </section>
      )}

      {/* Time Period */}
      {config.time_intervals.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Time Period
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {config.time_intervals.map((ti) => {
              const t = ti.time_interval;
              const value = [t.interval_value, t.interval_unit].filter(Boolean).join(' ');
              return (
                <Badge key={t.id} variant="outline">
                  {t.label ?? (value || t.id)}
                </Badge>
              );
            })}
          </div>
        </section>
      )}

      {/* Inputs */}
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Inputs ({config.inputs.length})
        </h3>
        {config.inputs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No inputs defined.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Label</th>
                <th className="py-1.5 pr-3 font-medium">Format</th>
                <th className="py-1.5 pr-3 font-medium">Standard Variable</th>
                <th className="py-1.5 pr-3 font-medium">Unit</th>
                <th className="py-1.5 font-medium">Optional</th>
              </tr>
            </thead>
            <tbody>
              {config.inputs.map((inp) => {
                const vp = inp.input.presentations?.[0]?.presentation;
                return (
                  <tr key={inp.input.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{inp.input.label}</td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {inp.input.has_format ?? '—'}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {vp?.standard_variable?.label ?? '—'}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">{vp?.unit?.label ?? '—'}</td>
                    <td className="py-2">
                      {inp.is_optional ? (
                        <Badge variant="outline" className="text-xs">
                          Optional
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          Required
                        </Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Outputs */}
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Outputs ({config.outputs.length})
        </h3>
        {config.outputs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No outputs defined.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Label</th>
                <th className="py-1.5 pr-3 font-medium">Format</th>
                <th className="py-1.5 pr-3 font-medium">Standard Variable</th>
                <th className="py-1.5 font-medium">Unit</th>
              </tr>
            </thead>
            <tbody>
              {config.outputs.map((out) => {
                const vp = out.output.presentations?.[0]?.presentation;
                return (
                  <tr key={out.output.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{out.output.label}</td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {out.output.has_format ?? '—'}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {vp?.standard_variable?.label ?? '—'}
                    </td>
                    <td className="py-2 text-muted-foreground">{vp?.unit?.label ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Parameters */}
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Parameters ({config.parameters.length})
        </h3>
        {config.parameters.length === 0 ? (
          <p className="text-sm text-muted-foreground">No parameters defined.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Label</th>
                <th className="py-1.5 pr-3 font-medium">Type</th>
                <th className="py-1.5 pr-3 font-medium">Default</th>
                <th className="py-1.5 font-medium">Fixed</th>
              </tr>
            </thead>
            <tbody>
              {config.parameters.map((cp) => {
                const p = cp.parameter;
                return (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{p.label}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{p.has_data_type ?? '—'}</td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {p.has_default_value ?? '—'}
                    </td>
                    <td className="py-2 text-muted-foreground">{p.has_fixed_value ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Steps (only when the configuration is a flow) */}
      <FlowStepsSection
        configurationId={config.id}
        inputs={config.inputs.map((inp) => ({ id: inp.input.id, label: inp.input.label }))}
        parameters={config.parameters.map((cp) => ({
          id: cp.parameter.id,
          label: cp.parameter.label,
        }))}
      />
    </div>
  );
}
