/**
 * RegisterTapisAppDialog — create the Tapis application a model runs, without
 * leaving the model form.
 *
 * The author pastes or uploads an app.json, reviews what it will create, and
 * confirms. Creating is two Tapis calls: create the app, then make it public.
 * They are separate, so the second can fail after the first succeeds; the app
 * then exists but is private, and the dialog offers to retry only the sharing.
 *
 * The dialog writes nothing to the model form. It tells its caller when the app
 * exists (`onCreated`) and, once the author agrees, to fill the form from it
 * (`onFill`).
 */
import * as React from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  MAX_APP_DEFINITION_BYTES,
  createTapisApp,
  parseTapisAppDefinition,
  shareTapisAppPublic,
  type TapisAppRef,
} from '@/lib/tapis-apps';

export interface RegisterTapisAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  /** Apps already listed, so a likely duplicate can be flagged before Create. */
  existingApps: TapisAppRef[];
  /** True when the form already has inputs or parameters a fill would replace. */
  hasRows: boolean;
  /** The app exists. The caller selects it and reloads its list. */
  onCreated: (ref: TapisAppRef) => void;
  /** Read the app back and fill the form from it. Rejects if it cannot be read. */
  onFill: (ref: TapisAppRef) => Promise<void>;
}

type Step = 'provide' | 'review' | 'done';
type FillState = 'pending' | 'filled' | 'kept' | 'failed';

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function RegisterTapisAppDialog({
  open,
  onOpenChange,
  tenant,
  existingApps,
  hasRows,
  onCreated,
  onFill,
}: RegisterTapisAppDialogProps) {
  const [step, setStep] = React.useState<Step>('provide');
  const [text, setText] = React.useState('');
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<TapisAppRef | null>(null);
  const [shareError, setShareError] = React.useState<string | null>(null);
  const [isPublic, setIsPublic] = React.useState(false);
  const [fill, setFill] = React.useState<FillState>('pending');

  // Start clean each time the dialog opens.
  React.useEffect(() => {
    if (open) return;
    setStep('provide');
    setText('');
    setFileError(null);
    setBusy(false);
    setCreateError(null);
    setCreated(null);
    setShareError(null);
    setIsPublic(false);
    setFill('pending');
  }, [open]);

  const parsed = React.useMemo(() => (text.trim() ? parseTapisAppDefinition(text) : null), [text]);

  const handleFile = async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    if (file.size > MAX_APP_DEFINITION_BYTES) {
      setFileError('That file is too large to be an app.json.');
      return;
    }
    setText(await file.text());
  };

  const runFill = async (ref: TapisAppRef) => {
    setFill('pending');
    try {
      await onFill(ref);
      setFill('filled');
    } catch {
      setFill('failed');
    }
  };

  const runShare = async (ref: TapisAppRef) => {
    setShareError(null);
    try {
      await shareTapisAppPublic(ref.tenant, ref.id);
      setIsPublic(true);
    } catch (err) {
      setShareError(message(err, 'Could not make the application public.'));
    }
  };

  const handleCreate = async () => {
    if (!parsed?.ok || busy) return;
    setBusy(true);
    setCreateError(null);
    let ref: TapisAppRef;
    try {
      ref = await createTapisApp(tenant, parsed.definition);
    } catch (err) {
      setCreateError(message(err, 'Could not create the application.'));
      setBusy(false);
      return;
    }
    // The app exists from here on. Nothing below may report the create as failed.
    setCreated(ref);
    onCreated(ref);
    setStep('done');
    await runShare(ref);
    if (!hasRows) await runFill(ref);
    setBusy(false);
  };

  const duplicate =
    parsed?.ok &&
    existingApps.some((a) => a.id === parsed.summary.id && a.version === parsed.summary.version);

  return (
    // A create in flight cannot be taken back, so the dialog stays until it settles.
    <Dialog open={open} onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Register a new application</DialogTitle>
          <DialogDescription>
            Create the Tapis application your model runs from its app.json.
          </DialogDescription>
        </DialogHeader>

        {step === 'provide' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="app-json-file">Upload an app.json</Label>
              <input
                id="app-json-file"
                type="file"
                accept=".json,application/json"
                className="block w-full text-sm"
                onChange={(e) => void handleFile(e.target.files?.[0])}
              />
              {fileError && (
                <p role="alert" className="text-xs text-destructive">
                  {fileError}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="app-json-text">Or paste it here</Label>
              <Textarea
                id="app-json-text"
                rows={12}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder='{ "id": "my-model", "version": "0.1.0", "containerImage": "docker://ghcr.io/me/my-model:0.1.0", ... }'
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              {parsed && !parsed.ok && (
                <p role="alert" className="text-xs text-destructive">
                  {parsed.error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={!parsed?.ok} onClick={() => setStep('review')}>
                Review
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'review' && parsed?.ok && (
          <div className="space-y-4">
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Id</dt>
              <dd className="font-medium">{parsed.summary.id}</dd>
              <dt className="text-muted-foreground">Version</dt>
              <dd>{parsed.summary.version}</dd>
              <dt className="text-muted-foreground">Container image</dt>
              <dd className="break-all">{parsed.summary.containerImage}</dd>
              <dt className="text-muted-foreground">Runs on</dt>
              <dd>{parsed.summary.execSystemId ?? 'Not stated'}</dd>
              <dt className="text-muted-foreground">Limits</dt>
              <dd>
                {[
                  parsed.summary.maxMinutes != null && `${parsed.summary.maxMinutes} min`,
                  parsed.summary.coresPerNode != null && `${parsed.summary.coresPerNode} core(s)`,
                  parsed.summary.memoryMB != null && `${parsed.summary.memoryMB} MB`,
                ]
                  .filter(Boolean)
                  .join(', ') || 'Not stated'}
              </dd>
              <dt className="text-muted-foreground">Inputs</dt>
              <dd>
                {parsed.summary.inputs.length > 0
                  ? parsed.summary.inputs
                      .map((i) => `${i.label}${i.isOptional ? ' (optional)' : ''}`)
                      .join(', ')
                  : 'No inputs to fill'}
              </dd>
              <dt className="text-muted-foreground">Settings</dt>
              <dd>
                {parsed.summary.parameters.length > 0
                  ? parsed.summary.parameters.map((p) => p.label).join(', ')
                  : 'None'}
              </dd>
            </dl>

            {duplicate && (
              <p className="flex items-start gap-1.5 text-sm text-amber-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  An application with this id and version already appears in your list. Tapis will
                  refuse to create it again, so change the version.
                </span>
              </p>
            )}
            {parsed.warnings.map((w) => (
              <p key={w} className="flex items-start gap-1.5 text-sm text-amber-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{w}</span>
              </p>
            ))}

            <p className="rounded-md border bg-muted/40 p-3 text-sm">
              This creates a real application under your account and makes it public, so anyone
              signed in to Tapis can see its definition and run it. DYNAMO cannot edit or remove it
              afterwards, and it exists even if you do not save the model.
            </p>

            {createError && (
              <p role="alert" className="text-sm text-destructive">
                {createError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setStep('provide')}
              >
                Back
              </Button>
              <Button type="button" disabled={busy} onClick={() => void handleCreate()}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create application
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'done' && created && (
          <div className="space-y-3 text-sm">
            <p className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              Created {created.id} {created.version}.
            </p>

            {isPublic && <p>It is public: anyone signed in to Tapis can see it and run it.</p>}
            {shareError && (
              <div className="space-y-2">
                <p role="alert" className="text-amber-700">
                  Created, but it could not be made public, so only you can run it. {shareError}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void runShare(created)}
                >
                  Make public
                </Button>
              </div>
            )}

            {fill === 'filled' && (
              <p>The inputs and parameters were filled in from the application.</p>
            )}
            {fill === 'kept' && <p>Your inputs and parameters were left as they were.</p>}
            {fill === 'failed' && (
              <p role="alert" className="text-amber-700">
                Created, but it could not be read back to fill the form. Use &ldquo;Fill inputs and
                parameters from the application&rdquo; below.
              </p>
            )}
            {hasRows && fill === 'pending' && (
              <div className="space-y-2">
                <p>
                  Your form already has inputs or parameters. Replace them with this
                  application&rsquo;s?
                </p>
                <div className="flex gap-2">
                  <Button type="button" size="sm" onClick={() => void runFill(created)}>
                    Replace
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setFill('kept')}>
                    Keep my rows
                  </Button>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
