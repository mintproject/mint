/**
 * Asks the user to accept what a flow's author chose before the run starts.
 *
 * A flow can carry values and links its author set. They run with the user's
 * account, so the run is not submitted until the user has read them and ticked
 * the box.
 */
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { FlowSettings } from '@/lib/ensemble-manager';
import { describeFlowLink } from '@/lib/flow-errors';

interface FlowSettingsDialogProps {
  settings: FlowSettings | null;
  onConfirm: () => void;
  onCancel: () => void;
}

function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function FlowSettingsDialog({ settings, onConfirm, onCancel }: FlowSettingsDialogProps) {
  const [accepted, setAccepted] = useState(false);
  useEffect(() => setAccepted(false), [settings]);

  const defaults = Object.entries(settings?.defaults ?? {});
  const links = settings?.links ?? [];

  return (
    <Dialog open={settings !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings chosen by the flow&apos;s author</DialogTitle>
          <DialogDescription>
            These were chosen by the flow&apos;s author and will be used with your account.
          </DialogDescription>
        </DialogHeader>
        {defaults.length > 0 && (
          <ul className="space-y-1 text-sm" data-testid="flow-settings-defaults">
            {defaults.map(([name, value]) => (
              <li key={name}>
                <span className="font-medium">{name}</span>: {valueText(value)}
              </li>
            ))}
          </ul>
        )}
        {links.length > 0 && (
          <ul className="space-y-1 text-sm" data-testid="flow-settings-links">
            {links.map((link, index) => (
              <li key={index}>{describeFlowLink(link)}</li>
            ))}
          </ul>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          I accept these settings
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!accepted} onClick={onConfirm}>
            Accept and run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
