/**
 * Asks the user to accept what a flow's author chose before the run starts.
 *
 * A flow can carry values and links its author set. They run with the user's
 * account, so the run is not submitted until the user has read them and ticked
 * the box.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { FlowSettings, FlowStep, RequiredSecret, SendsDataTo } from '@/lib/ensemble-manager';
import { describeFlowDefault, describeFlowLink } from '@/lib/flow-errors';

/** What the user must see or settle before a flow run is submitted. */
export interface FlowRunGate {
  /** The author's settings, when there are any to accept. */
  settings?: FlowSettings;
  /** The flow's steps, to name the step a setting belongs to. */
  steps?: FlowStep[];
  /** Outside services the run sends data to; ticked on every run. */
  sendsDataTo?: SendsDataTo[];
  /** Saved credentials the flow needs; set only when the plan is not ready. */
  requiredSecrets?: RequiredSecret[];
}

interface FlowSettingsDialogProps {
  gate: FlowRunGate | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function FlowSettingsDialog({ gate, onConfirm, onCancel }: FlowSettingsDialogProps) {
  const [acceptedSettings, setAcceptedSettings] = useState(false);
  const [acceptedOutside, setAcceptedOutside] = useState(false);
  useEffect(() => {
    setAcceptedSettings(false);
    setAcceptedOutside(false);
  }, [gate]);

  const defaults = Object.entries(gate?.settings?.defaults ?? {});
  const links = gate?.settings?.links ?? [];
  const hasSettings = defaults.length > 0 || links.length > 0;
  const outside = gate?.sendsDataTo ?? [];
  const secrets = gate?.requiredSecrets ?? [];
  const blocked = gate?.requiredSecrets !== undefined;

  const title = blocked
    ? 'Saved credentials needed'
    : hasSettings
      ? "Settings chosen by the flow's author"
      : 'Before this run';
  const canRun = (!hasSettings || acceptedSettings) && (outside.length === 0 || acceptedOutside);

  return (
    <Dialog open={gate !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {hasSettings && !blocked && (
            <DialogDescription>
              These were chosen by the flow&apos;s author and will be used with your account.
            </DialogDescription>
          )}
        </DialogHeader>
        {blocked && (
          <div className="space-y-2 text-sm" data-testid="flow-required-secrets">
            <p>This flow needs these saved credentials:</p>
            <ul className="space-y-1">
              {secrets.map((secret) => (
                <li key={secret.name}>
                  <span className="font-medium">{secret.label || secret.name}</span> ({secret.name}
                  {secret.fields?.length ? `: ${secret.fields.join(', ')}` : ''}){' '}
                  {secret.stored ? 'is stored' : 'is not stored yet'}
                </li>
              ))}
            </ul>
            <Link to="/account/credentials" className="text-blue-700 underline" onClick={onCancel}>
              Open saved credentials
            </Link>
          </div>
        )}
        {!blocked && hasSettings && (
          <>
            {defaults.length > 0 && (
              <ul className="space-y-1 text-sm" data-testid="flow-settings-defaults">
                {defaults.map(([name, value]) => (
                  <li key={name}>{describeFlowDefault(name, value)}</li>
                ))}
              </ul>
            )}
            {links.length > 0 && (
              <ul className="space-y-1 text-sm" data-testid="flow-settings-links">
                {links.map((link, index) => (
                  <li key={index}>{describeFlowLink(link, gate?.steps)}</li>
                ))}
              </ul>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={acceptedSettings}
                onChange={(e) => setAcceptedSettings(e.target.checked)}
              />
              I accept these settings
            </label>
          </>
        )}
        {!blocked && outside.length > 0 && (
          <>
            <div className="text-sm" data-testid="flow-sends-data-to">
              <p>This run sends data outside DYNAMO:</p>
              <ul className="mt-1 space-y-1">
                {outside.map((item, index) => (
                  <li key={index}>
                    <span className="font-medium">{item.service}</span>
                    {item.what ? `: ${item.what}` : ''}
                  </li>
                ))}
              </ul>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={acceptedOutside}
                onChange={(e) => setAcceptedOutside(e.target.checked)}
              />
              I agree to send this data outside DYNAMO
            </label>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {blocked ? 'Close' : 'Cancel'}
          </Button>
          {!blocked && (
            <Button disabled={!canRun} onClick={onConfirm}>
              Accept and run
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
