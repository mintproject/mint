import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { StandardVariableCombobox } from '@/components/autocomplete/StandardVariableCombobox';
import {
  ARGUMENT_TYPES,
  emptyContract,
  type ArgumentType,
  type ContractField,
  type PieceFormState,
  type PieceVisibility,
} from '@/lib/piece-authoring';

const SELECT_CLASS =
  'mt-1 block w-full rounded border border-input bg-background px-3 py-2 text-sm';

function Help({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

function ContractRows({
  role,
  rows,
  onChange,
}: {
  role: 'input' | 'output';
  rows: ContractField[];
  onChange: (rows: ContractField[]) => void;
}) {
  const update = (index: number, patch: Partial<ContractField>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="rounded-md border p-4">
      <legend className="px-1 text-sm font-medium">
        {role === 'input' ? 'Inputs' : 'Outputs'}
      </legend>
      {rows.map((row, index) => (
        <div key={index} className="mb-3 grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
          <StandardVariableCombobox
            value={
              row.standardVariableUri
                ? { id: row.standardVariableUri, label: row.standardVariableUri, description: null }
                : null
            }
            onChange={(option) => update(index, { standardVariableUri: option?.id ?? '' })}
            placeholder={`Choose ${role} variable`}
          />
          <Input
            aria-label={`${role} ${index + 1} format`}
            placeholder="Format (csv, netcdf, directory)"
            value={row.format}
            onChange={(e) => update(index, { format: e.target.value })}
          />
          <Input
            aria-label={`${role} ${index + 1} unit`}
            placeholder="Unit"
            value={row.unit}
            onChange={(e) => update(index, { unit: e.target.value })}
          />
          <Button
            type="button"
            variant="outline"
            disabled={rows.length === 1}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" onClick={() => onChange([...rows, emptyContract()])}>
        Add {role}
      </Button>
      <Help>
        Each {role} is a standard variable with its format. The adapter uses them to decide which
        pieces and data fit together.
      </Help>
    </fieldset>
  );
}

export function PieceFromRepositoryForm({
  value,
  onChange,
}: {
  value: PieceFormState;
  onChange: (next: PieceFormState) => void;
}) {
  const set = <K extends keyof PieceFormState>(key: K, next: PieceFormState[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="piece-label">Name</Label>
          <Input
            id="piece-label"
            value={value.label}
            onChange={(e) => set('label', e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="piece-version">Version</Label>
          <Input
            id="piece-version"
            value={value.version}
            onChange={(e) => set('version', e.target.value)}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="piece-description">Description</Label>
        <Textarea
          id="piece-description"
          rows={2}
          value={value.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </div>
      <fieldset className="rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Code</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="piece-repository">Repository</Label>
            <Input
              id="piece-repository"
              placeholder="owner/name"
              value={value.repository}
              onChange={(e) => set('repository', e.target.value)}
            />
            <Help>A public GitHub repository. Private repositories are not supported.</Help>
          </div>
          <div>
            <Label htmlFor="piece-commit">Commit</Label>
            <Input
              id="piece-commit"
              className="font-mono"
              placeholder="40-character commit SHA"
              value={value.commit}
              onChange={(e) => set('commit', e.target.value)}
            />
            <Help>
              The full commit SHA. A branch or tag is not accepted, because it can move after the
              piece is approved.
            </Help>
          </div>
          <div>
            <Label htmlFor="piece-path">Path to the source file</Label>
            <Input
              id="piece-path"
              placeholder="pieces/clean.py"
              value={value.path}
              onChange={(e) => set('path', e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="piece-entrypoint">Entrypoint</Label>
            <Input
              id="piece-entrypoint"
              value={value.entrypoint}
              onChange={(e) => set('entrypoint', e.target.value)}
            />
            <Help>
              The function in that file. It is called with a dict of the step&apos;s inputs.
            </Help>
          </div>
        </div>
      </fieldset>
      <div className="grid gap-4 lg:grid-cols-2">
        <ContractRows role="input" rows={value.inputs} onChange={(rows) => set('inputs', rows)} />
        <ContractRows
          role="output"
          rows={value.outputs}
          onChange={(rows) => set('outputs', rows)}
        />
      </div>

      <fieldset className="rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Run arguments</legend>
        {value.arguments.map((argument, index) => {
          const update = (patch: Partial<typeof argument>) =>
            set(
              'arguments',
              value.arguments.map((a, i) => (i === index ? { ...a, ...patch } : a)),
            );
          return (
            <div key={index} className="mb-3 grid gap-2 sm:grid-cols-[1fr_8rem_1fr_2fr_auto_auto]">
              <Input
                aria-label={`argument ${index + 1} name`}
                placeholder="name"
                value={argument.name}
                onChange={(e) => update({ name: e.target.value })}
              />
              <select
                aria-label={`argument ${index + 1} type`}
                className={SELECT_CLASS}
                value={argument.type}
                onChange={(e) => update({ type: e.target.value as ArgumentType })}
              >
                {ARGUMENT_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <Input
                aria-label={`argument ${index + 1} default`}
                placeholder="default"
                value={argument.defaultText}
                onChange={(e) => update({ defaultText: e.target.value })}
              />
              <Input
                aria-label={`argument ${index + 1} description`}
                placeholder="description"
                value={argument.description}
                onChange={(e) => update({ description: e.target.value })}
              />
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={argument.required}
                  onChange={(e) => update({ required: e.target.checked })}
                />
                required
              </label>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  set(
                    'arguments',
                    value.arguments.filter((_, i) => i !== index),
                  )
                }
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            set('arguments', [
              ...value.arguments,
              { name: '', type: 'string', defaultText: '', description: '', required: false },
            ])
          }
        >
          Add argument
        </Button>
        <Help>Each argument is passed to the function as a task input named in capitals.</Help>
      </fieldset>

      <fieldset className="rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Secrets the piece needs</legend>
        {value.secrets.map((secret, index) => {
          const update = (patch: Partial<typeof secret>) =>
            set(
              'secrets',
              value.secrets.map((s, i) => (i === index ? { ...s, ...patch } : s)),
            );
          return (
            <div key={index} className="mb-3 grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
              <Input
                aria-label={`secret ${index + 1} name`}
                placeholder="name (e.g. openai)"
                value={secret.name}
                onChange={(e) => update({ name: e.target.value })}
              />
              <Input
                aria-label={`secret ${index + 1} label`}
                placeholder="label shown to the runner"
                value={secret.label}
                onChange={(e) => update({ label: e.target.value })}
              />
              <Textarea
                aria-label={`secret ${index + 1} inputs`}
                rows={2}
                placeholder={'OPENAI_API_KEY=api_key'}
                value={secret.envText}
                onChange={(e) => update({ envText: e.target.value })}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  set(
                    'secrets',
                    value.secrets.filter((_, i) => i !== index),
                  )
                }
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          onClick={() => set('secrets', [...value.secrets, { name: '', label: '', envText: '' }])}
        >
          Add secret
        </Button>
        <Help>
          The runner supplies their own stored secret. One line per task input: INPUT_NAME=field of
          the secret.
        </Help>
      </fieldset>

      <fieldset className="rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Data sent outside DYNAMO</legend>
        {value.sends.map((send, index) => {
          const update = (patch: Partial<typeof send>) =>
            set(
              'sends',
              value.sends.map((s, i) => (i === index ? { ...s, ...patch } : s)),
            );
          return (
            <div key={index} className="mb-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
              <Input
                aria-label={`destination ${index + 1} service`}
                placeholder="service (api.example.com)"
                value={send.service}
                onChange={(e) => update({ service: e.target.value })}
              />
              <Input
                aria-label={`destination ${index + 1} what`}
                placeholder="what is sent"
                value={send.what}
                onChange={(e) => update({ what: e.target.value })}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  set(
                    'sends',
                    value.sends.filter((_, i) => i !== index),
                  )
                }
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          onClick={() => set('sends', [...value.sends, { service: '', what: '' }])}
        >
          Add destination
        </Button>
        <Help>Say where the code sends data. An approver reads this before approving.</Help>
      </fieldset>

      <div>
        <Label htmlFor="piece-visibility">Visibility</Label>
        <select
          id="piece-visibility"
          className={SELECT_CLASS}
          value={value.visibility}
          onChange={(e) => set('visibility', e.target.value as PieceVisibility)}
        >
          <option value="private">private (only you can run it)</option>
          <option value="shared">shared (needs approval before others run it)</option>
          <option value="public">public (needs approval before others run it)</option>
        </select>
      </div>
    </div>
  );
}
