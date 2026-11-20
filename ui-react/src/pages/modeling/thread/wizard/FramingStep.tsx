import { useEffect, useMemo, useState } from 'react';

import {
  Thread,
  getUserPermission,
  useUpdateThreadMutation,
  useInsertThreadProvenanceMutation,
} from '@/graphql/generated/modeling';
import { useAuth } from '@/lib/auth/useAuth';
import { useToast } from '@/components/ui/use-toast';
import { StepShell } from './StepShell';
import {
  SpatialScopeMap,
  type SpatialFeatureSelection,
  type SpatialLayerSelection,
  type SpatialSelection,
} from '../SpatialScopeMap';

interface FramingStepProps {
  thread: Thread;
  onUpdated: () => void;
  onContinue: () => void;
  onBack?: () => void;
  spatialSelection?: SpatialSelection | null;
  onSpatialSelectionChange?: (selection: SpatialSelection | null) => void;
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  return iso.split('T')[0] ?? iso;
}

export function FramingStep({
  thread,
  onUpdated,
  onContinue,
  onBack,
  spatialSelection,
  onSpatialSelectionChange,
}: FramingStepProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const perm = getUserPermission(thread.permissions, thread.events, user?.username ?? null);

  const [name, setName] = useState(thread.name ?? '');
  const [regionOn, setRegionOn] = useState(!!thread.region_id);
  const [regionId, setRegionId] = useState(thread.region_id ?? '');
  const [datesOn, setDatesOn] = useState(!!thread.start_date || !!thread.end_date);
  const [startDate, setStartDate] = useState(fmtDate(thread.start_date));
  const [endDate, setEndDate] = useState(fmtDate(thread.end_date));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(thread.name ?? '');
    setRegionOn(!!thread.region_id);
    setRegionId(thread.region_id ?? '');
    setStartDate(fmtDate(thread.start_date));
    setEndDate(fmtDate(thread.end_date));
  }, [thread]);

  const [updateThread] = useUpdateThreadMutation();
  const [insertProvenance] = useInsertThreadProvenanceMutation();

  const goalSet = name.trim().length > 0;
  const datesValid = useMemo(() => {
    if (!datesOn || !startDate || !endDate) return true; // open-ended ranges allowed
    return startDate < endDate;
  }, [datesOn, startDate, endDate]);

  const canContinue = goalSet && datesValid;

  async function handleContinue() {
    if (!canContinue) return;
    setSaving(true);
    try {
      await updateThread({
        variables: {
          id: thread.id,
          name: name.trim(),
          startDate: datesOn ? startDate : thread.start_date,
          endDate: datesOn ? endDate : thread.end_date,
          regionId: regionOn && regionId ? regionId : null,
          drivingVariableId: thread.driving_variable_id ?? null,
          responseVariableId: thread.response_variable_id ?? null,
        },
      });
      if (user?.username) {
        await insertProvenance({
          variables: { threadId: thread.id, event: 'UPDATE', userid: user.username, notes: null },
        });
      }
      onUpdated();
      onContinue();
    } catch (err) {
      toast({ title: 'Save failed', description: String(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  const readOnly = !perm.write;

  return (
    <StepShell
      title="Framing"
      description="Set the scope of this sub-task. The region and time period you set here narrow the datasets available later."
      canContinue={canContinue && !saving}
      continueHint={goalSet ? undefined : 'A goal name is required'}
      continueLabel={saving ? 'Saving…' : 'Continue'}
      onContinue={handleContinue}
      onBack={onBack}
    >
      <div className="max-w-xl space-y-5 text-sm">
        {/* Goal (required) */}
        <div className="flex flex-col gap-1">
          <label htmlFor="framing-goal" className="font-semibold">
            Goal <span className="text-red-500">*</span>
          </label>
          <input
            id="framing-goal"
            type="text"
            value={name}
            disabled={readOnly}
            onChange={(e) => setName(e.target.value)}
            placeholder="Describe the goal of this sub-task"
            className="rounded border border-gray-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <fieldset className="space-y-4 rounded border p-3">
          <legend className="px-1 text-xs font-medium text-gray-500">
            Narrow the data — optional
          </legend>

          {/* Spatial boundary toggle */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                data-testid="toggle-region"
                checked={regionOn}
                disabled={readOnly}
                onChange={(e) => {
                  setRegionOn(e.target.checked);
                  if (!e.target.checked) onSpatialSelectionChange?.(null);
                }}
              />
              Spatial boundary{' '}
              {!regionOn && (
                <span className="text-xs font-normal text-gray-400">off · any boundary</span>
              )}
            </label>
            <div className="space-y-1 pl-6">
              <SpatialScopeMap
                geometries={(thread.region?.geometries ?? [])
                  .map((geometry) => geometry.geometry)
                  .filter(Boolean)}
                label={spatialSelection?.feature?.label ?? thread.region?.name}
                scopeId={spatialSelection?.feature?.filterValue ?? regionId}
                sourceUri={spatialSelection?.layer?.source_uri ?? spatialSelection?.layer?.uri}
                filterField={spatialSelection?.feature?.filterField}
                filterValue={spatialSelection?.feature?.filterValue}
                disabled={readOnly}
                onLayerSelect={(layer: SpatialLayerSelection) => {
                  if (regionOn) onSpatialSelectionChange?.({ layer });
                }}
                onFeatureSelect={(feature: SpatialFeatureSelection) => {
                  setRegionOn(true);
                  onSpatialSelectionChange?.({
                    layer: feature.layer ?? spatialSelection?.layer,
                    feature,
                  });
                }}
              />
              <p className="text-xs text-blue-600">
                ⌖ Datasets and adapter transforms will use the selected spatial boundary
              </p>
            </div>
          </div>

          {/* Dates toggle */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                data-testid="toggle-dates"
                checked={datesOn}
                disabled={readOnly}
                onChange={(e) => setDatesOn(e.target.checked)}
              />
              Time period{' '}
              {!datesOn && (
                <span className="text-xs font-normal text-gray-400">off · any period</span>
              )}
            </label>
            {datesOn && (
              <div className="space-y-1 pl-6">
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    aria-label="Start date"
                    value={startDate}
                    disabled={readOnly}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1.5"
                  />
                  <span className="text-gray-400">to</span>
                  <input
                    type="date"
                    aria-label="End date"
                    value={endDate}
                    disabled={readOnly}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1.5"
                  />
                </div>
                {!datesValid && (
                  <p className="text-xs text-red-500">Start date must be before end date.</p>
                )}
                <p className="text-xs text-blue-600">
                  🗓 Datasets will be filtered to those overlapping this window
                </p>
              </div>
            )}
          </div>
        </fieldset>
      </div>
    </StepShell>
  );
}
