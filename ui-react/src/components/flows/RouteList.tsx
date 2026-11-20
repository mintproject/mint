/**
 * The pieces that make a wanted result, grouped by the kind of route, best first,
 * each with a button that takes the whole route into the flow.
 *
 * A model is not a flow step: a "from a model" route adds a flow input for the
 * model's output, and the person runs the model in a thread to get that data.
 * Nothing here says a route is complete beyond what the adapter reported; the
 * live check on the flow has the last word.
 */
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import {
  datasetName,
  groupRoutes,
  isConverter,
  modelOutputName,
  readableName,
  uniqueDatasets,
  uniqueModels,
  type RouteChoice,
  type RouteEntry,
  type RouteNeed,
} from '@/lib/flow-routes';
import { slugFromUri } from '@/lib/uri';

const MAX_PROVIDERS = 5;

export interface RouteListProps {
  produces: RouteEntry[];
  wantedLabel: string;
  pieceLabel: (id: string) => string;
  sourceLabel: (source: RouteNeed['direct'][number]['source']) => string;
  onAddRoute: (entry: RouteEntry, choice?: RouteChoice) => void;
}

export function RouteList({
  produces,
  wantedLabel,
  pieceLabel,
  sourceLabel,
  onAddRoute,
}: RouteListProps) {
  const groups = groupRoutes(produces);
  const nameOf = (entry: RouteEntry) =>
    readableName(entry.label?.trim() || pieceLabel(entry.piece) || entry.piece);
  const entryProps = { nameOf, pieceLabel, sourceLabel, onAddRoute };
  const example = groups.data.find(isConverter);
  return (
    <div className="space-y-3" data-testid="routes">
      <Group title="Ready: every input has a source in your flow" entries={groups.ready}>
        {(entry) => <Entry key={entry.piece + entry.output} entry={entry} {...entryProps} />}
      </Group>
      <Group title="From a model" entries={groups.model}>
        {(entry) => <Entry key={entry.piece + entry.output} entry={entry} {...entryProps} />}
      </Group>
      <Group
        title={
          groups.data.every(isConverter)
            ? `Convert ${wantedLabel} data you already have${example ? ` (e.g. ${nameOf(example)})` : ''}`
            : 'From data you already have'
        }
        entries={groups.data}
      >
        {(entry) => <Entry key={entry.piece + entry.output} entry={entry} {...entryProps} />}
      </Group>
      {groups.converter.length > 0 && (
        <details data-testid="route-group-converters">
          <summary className="cursor-pointer font-medium">
            Unit conversions ({groups.converter.length})
          </summary>
          <ul className="mt-1 space-y-2">
            {groups.converter.map((entry) => (
              <Entry key={entry.piece + entry.output} entry={entry} {...entryProps} />
            ))}
          </ul>
        </details>
      )}
      <Group title="No source found yet" entries={groups.none}>
        {(entry) => <Entry key={entry.piece + entry.output} entry={entry} {...entryProps} />}
      </Group>
    </div>
  );
}

function Group({
  title,
  entries,
  children,
}: {
  title: string;
  entries: RouteEntry[];
  children: (entry: RouteEntry) => React.ReactNode;
}) {
  if (entries.length === 0) return null;
  return (
    <section aria-label={title}>
      <h4 className="font-medium">{title}</h4>
      <ul className="mt-1 space-y-2">{entries.map(children)}</ul>
    </section>
  );
}

const withFormat = (text: string, format?: string | null) =>
  format ? `${text} (${format})` : text;
const approvalNote = (approval?: string | null) =>
  approval === 'denied' ? ' (you cannot run this piece yet)' : '';

function needName(need: RouteNeed): string {
  const variable = need.variable_label || (need.variable ? slugFromUri(need.variable) : '');
  return withFormat(variable || `input ${need.input}`, need.format);
}

function Entry({
  entry,
  nameOf,
  pieceLabel,
  sourceLabel,
  onAddRoute,
}: {
  entry: RouteEntry;
  nameOf: (entry: RouteEntry) => string;
  pieceLabel: (id: string) => string;
  sourceLabel: RouteListProps['sourceLabel'];
  onAddRoute: RouteListProps['onAddRoute'];
}) {
  const name = nameOf(entry);
  const unmet = entry.inputs.filter((need) => !need.met);
  const made = entry.output_label
    ? withFormat(entry.output_label, entry.output_format)
    : `output ${entry.output}`;
  const units =
    isConverter(entry) && entry.output_unit
      ? entry.inputs.find((need) => need.unit && need.unit !== entry.output_unit)?.unit
      : null;
  return (
    <li data-testid="route" className="rounded border bg-background p-2">
      <p>
        <span className="font-medium">{name}</span> makes {made}
        {units ? ` (${units} to ${entry.output_unit})` : ''}
        <span className="text-muted-foreground">{approvalNote(entry.approval)}</span>
      </p>
      <ul className="ml-4 list-disc">
        {entry.inputs.map((need) => (
          <li key={need.input}>
            needs: {needName(need)}
            {need.met ? (
              <span className="text-muted-foreground">
                {' '}
                {need.direct[0]
                  ? `from ${sourceLabel(need.direct[0].source)}`
                  : `through ${need.chains[0]?.pieces
                      .map((piece) => readableName(piece.label?.trim() || pieceLabel(piece.piece)))
                      .join(' then ')}`}
              </span>
            ) : (
              <Providers
                need={need}
                name={name}
                onAddRoute={(choice) => onAddRoute(entry, choice)}
              />
            )}
          </li>
        ))}
      </ul>
      {unmet.length === 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-1"
          aria-label={`Add this route: ${name}`}
          onClick={() => onAddRoute(entry)}
        >
          Add this route
        </Button>
      )}
    </li>
  );
}

function Providers({
  need,
  name,
  onAddRoute,
}: {
  need: RouteNeed;
  name: string;
  onAddRoute: (choice: RouteChoice) => void;
}) {
  const models = uniqueModels(need.providers?.models ?? []);
  const datasets = uniqueDatasets(need.providers?.datasets ?? []);
  if (models.length === 0 && datasets.length === 0) {
    return <span className="text-muted-foreground"> nothing provides it yet</span>;
  }
  const canAdd = Boolean(need.variable);
  return (
    <ul className="ml-4 list-disc text-muted-foreground" data-testid="need-providers">
      {models.slice(0, MAX_PROVIDERS).map((model) => {
        const label = model.label || model.configuration_id;
        return (
          <li key={`${model.configuration_id}#${model.output ?? ''}`}>
            Run{' '}
            <Link
              className="underline"
              to={`/modelconfigurations/${slugFromUri(model.configuration_id)}`}
            >
              {label}
            </Link>{' '}
            in a thread, then use its {modelOutputName(model, need)} as this flow&apos;s input{' '}
            {canAdd && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Add this route: ${name} from model ${label}`}
                onClick={() => onAddRoute({ input: need.input, kind: 'model', model })}
              >
                Add this route
              </Button>
            )}
          </li>
        );
      })}
      {datasets.slice(0, MAX_PROVIDERS).map((dataset) => {
        const label = datasetName(dataset);
        return (
          <li key={dataset.data_object_id}>
            Use dataset{' '}
            {dataset.url ? (
              <a className="underline" href={dataset.url} target="_blank" rel="noreferrer">
                {label}
              </a>
            ) : (
              label
            )}{' '}
            {canAdd && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Add this route: ${name} from dataset ${label}`}
                onClick={() => onAddRoute({ input: need.input, kind: 'dataset', dataset })}
              >
                Add this route
              </Button>
            )}
          </li>
        );
      })}
      {(models.length > MAX_PROVIDERS || datasets.length > MAX_PROVIDERS) && (
        <li>and more not shown</li>
      )}
    </ul>
  );
}
