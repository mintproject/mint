/**
 * Saved credentials: the signed-in user's own secrets, kept by the adapter.
 *
 * A value is typed into a password field, sent once and never shown again, so
 * replacing a credential means entering every field again. Values live only in
 * this form's state and are dropped as soon as the save succeeds.
 */
import { useCallback, useEffect, useState } from 'react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  deleteUserSecret,
  listUserSecrets,
  MODEL_SERVER_PRESET,
  saveUserSecret,
  validateUserSecret,
  type UserSecret,
} from '@/lib/user-secrets';

interface FormField {
  key: number;
  name: string;
  value: string;
}

interface FormState {
  mode: 'add' | 'replace';
  name: string;
  fields: FormField[];
}

let nextKey = 0;
const blankField = (name = ''): FormField => ({ key: nextKey++, name, value: '' });

function formatTime(iso?: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

function errorSentence(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

export function CredentialsPage() {
  const [secrets, setSecrets] = useState<UserSecret[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSecrets(await listUserSecrets());
      setLoadError(null);
    } catch (error) {
      setLoadError(errorSentence(error));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const open = (next: FormState) => {
    setForm(next);
    setFormError(null);
    setNotice(null);
  };

  const startAdd = () => open({ mode: 'add', name: '', fields: [blankField()] });
  const startPreset = () =>
    open({
      mode: 'add',
      name: MODEL_SERVER_PRESET.name,
      fields: MODEL_SERVER_PRESET.fields.map(blankField),
    });
  const startReplace = (secret: UserSecret) =>
    open({ mode: 'replace', name: secret.name, fields: secret.fields.map(blankField) });

  const close = () => {
    setForm(null);
    setFormError(null);
  };

  const patchField = (key: number, patch: Partial<FormField>) =>
    setForm((f) =>
      f ? { ...f, fields: f.fields.map((x) => (x.key === key ? { ...x, ...patch } : x)) } : f,
    );

  const save = async () => {
    if (!form) return;
    const problem = validateUserSecret(form.name, form.fields);
    if (problem) {
      setFormError(problem);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const fields: Record<string, string> = {};
      for (const f of form.fields) fields[f.name] = f.value;
      await saveUserSecret(form.name, fields);
      const verb = form.mode === 'replace' ? 'replaced' : 'saved';
      // Drop every typed value from state before anything else happens.
      setForm(null);
      setNotice(`Credential "${form.name}" ${verb}.`);
      await reload();
    } catch (error) {
      setFormError(errorSentence(error));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    const name = toDelete;
    if (!name) return;
    setNotice(null);
    try {
      await deleteUserSecret(name);
      setNotice(`Credential "${name}" deleted.`);
      await reload();
    } catch (error) {
      setLoadError(errorSentence(error));
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Saved credentials</h1>
        <p className="text-sm text-gray-600">
          A flow step that needs this credential fetches it when it starts. It never appears in your
          threads or runs.
        </p>
        <p className="text-sm text-gray-600">
          A value is sent once and never shown again, so replacing a credential means entering every
          field again.
        </p>
      </header>

      {notice && (
        <p role="status" className="rounded border border-green-200 bg-green-50 p-2 text-sm">
          {notice}
        </p>
      )}
      {loadError && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm">
          {loadError}
        </p>
      )}

      <section aria-label="Your credentials" className="space-y-2">
        {secrets === null && !loadError && <p className="text-sm">Loading...</p>}
        {secrets?.length === 0 && (
          <p className="text-sm text-gray-600">You have no saved credentials.</p>
        )}
        {secrets?.map((s) => (
          <div
            key={s.name}
            data-testid={`credential-${s.name}`}
            className="flex items-start justify-between gap-4 rounded border border-gray-200 p-3"
          >
            <div className="space-y-1 text-sm">
              <div className="font-medium">{s.name}</div>
              <div>Fields: {s.fields.join(', ')}</div>
              <div className="text-gray-600">
                Last changed: {formatTime(s.updated_at)} · Last used: {formatTime(s.last_used_at)}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" onClick={() => startReplace(s)}>
                Replace
              </Button>
              <Button variant="outline" size="sm" onClick={() => setToDelete(s.name)}>
                Delete
              </Button>
            </div>
          </div>
        ))}
      </section>

      {!form && (
        <div className="flex gap-2">
          <Button onClick={startAdd}>Add a credential</Button>
          <Button variant="outline" onClick={startPreset}>
            Add a model server
          </Button>
        </div>
      )}

      {form && (
        <form
          aria-label={form.mode === 'replace' ? 'Replace credential' : 'Add credential'}
          autoComplete="off"
          className="space-y-3 rounded border border-gray-200 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h2 className="text-lg font-medium">
            {form.mode === 'replace' ? `Replace "${form.name}"` : 'Add a credential'}
          </h2>
          {form.mode === 'replace' && (
            <p className="text-sm text-gray-600">
              Values are never shown. Enter every field again; the old values are replaced.
            </p>
          )}
          <div className="space-y-1">
            <Label htmlFor="credential-name">Name</Label>
            <Input
              id="credential-name"
              value={form.name}
              readOnly={form.mode === 'replace'}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          {form.fields.map((f, index) => (
            <div key={f.key} className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor={`field-name-${f.key}`}>Field name {index + 1}</Label>
                <Input
                  id={`field-name-${f.key}`}
                  value={f.name}
                  readOnly={form.mode === 'replace'}
                  autoComplete="off"
                  onChange={(e) => patchField(f.key, { name: e.target.value })}
                />
              </div>
              <div className="flex-1 space-y-1">
                <Label htmlFor={`field-value-${f.key}`}>Value {index + 1}</Label>
                <Input
                  id={`field-value-${f.key}`}
                  type="password"
                  value={f.value}
                  autoComplete="off"
                  onChange={(e) => patchField(f.key, { value: e.target.value })}
                />
              </div>
              {form.mode === 'add' && form.fields.length > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Remove field ${index + 1}`}
                  onClick={() =>
                    setForm({ ...form, fields: form.fields.filter((x) => x.key !== f.key) })
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          {form.mode === 'add' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setForm({ ...form, fields: [...form.fields, blankField()] })}
            >
              Add a field
            </Button>
          )}
          {formError && (
            <p role="alert" className="text-sm text-red-700">
              {formError}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete this credential?"
        description={`"${toDelete ?? ''}" will be removed. A flow that needs it will not run until you save it again.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
