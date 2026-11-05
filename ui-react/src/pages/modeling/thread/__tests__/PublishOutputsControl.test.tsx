/**
 * Tests for PublishOutputsControl — the optional "Publish outputs" run-form section.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { PlanPublisher } from '@/lib/ensemble-manager';
import { PublishOutputsControl } from '../PublishOutputsControl';
import { publishRequestFor, type PublishSelection } from '@/lib/publish-outputs';

const publisher: PlanPublisher = {
  transform_spec_id: 'ts-stac',
  name: 'SUBSIDE STAC publish',
  catalog_tokens: ['ckan', 'stac'],
  parameters: [
    {
      name: 'stac_collection',
      type: 'string',
      required: true,
      default: 'subsidence-rates-dev',
      allowed_values: ['subsidence-rates-dev', 'subsidence-rates'],
    },
    {
      name: 'ckan_org',
      type: 'string',
      required: true,
      default: 'tacc-water',
      allowed_values: ['tacc-water'],
    },
    { name: 'public', type: 'boolean', required: false, default: false },
  ],
  can_publish: { ok: true, reason: null },
};

function Harness({ publishers }: { publishers: PlanPublisher[] }) {
  const [selection, setSelection] = useState<PublishSelection | null>(null);
  return (
    <>
      <PublishOutputsControl
        modelId="m1"
        publishers={publishers}
        selection={selection}
        onChange={setSelection}
      />
      <output data-testid="request">
        {JSON.stringify(publishRequestFor(publishers, selection) ?? null)}
      </output>
    </>
  );
}

describe('PublishOutputsControl', () => {
  it('renders nothing when there are no publishers', () => {
    const { container } = render(
      <PublishOutputsControl modelId="m1" publishers={[]} selection={null} onChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('is disabled and shows the reason when the user cannot publish', () => {
    render(
      <PublishOutputsControl
        modelId="m1"
        publishers={[
          {
            ...publisher,
            can_publish: { ok: false, reason: 'You are not a member of any CKAN organization' },
          },
        ]}
        selection={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('publish-toggle-m1')).toBeDisabled();
    expect(screen.getByTestId('publish-blocked-m1')).toHaveTextContent(
      'You are not a member of any CKAN organization',
    );
  });

  it('labels the catalog by its tokens and renders parameters from allowed values', () => {
    render(<Harness publishers={[publisher]} />);
    fireEvent.click(screen.getByTestId('publish-toggle-m1'));
    expect(screen.getByTestId('publish-catalog-m1')).toHaveTextContent('ckan + stac');
    const collection = screen.getByTestId('publish-param-m1-stac_collection');
    expect(collection.tagName).toBe('SELECT');
    expect(collection).toHaveValue('subsidence-rates-dev');
    expect(screen.getByTestId('publish-param-m1-public')).not.toBeChecked();
    expect(screen.getByText('The SUBSIDE map needs public assets')).toBeInTheDocument();
  });

  it('turns the chosen catalog and values into a publish request', () => {
    render(<Harness publishers={[publisher]} />);
    expect(screen.getByTestId('request')).toHaveTextContent('null');
    fireEvent.click(screen.getByTestId('publish-toggle-m1'));
    fireEvent.change(screen.getByTestId('publish-param-m1-stac_collection'), {
      target: { value: 'subsidence-rates' },
    });
    fireEvent.click(screen.getByTestId('publish-param-m1-public'));
    expect(JSON.parse(screen.getByTestId('request').textContent ?? '')).toEqual({
      tokens: ['ckan', 'stac'],
      values: { stac_collection: 'subsidence-rates', ckan_org: 'tacc-water', public: true },
    });
    fireEvent.click(screen.getByTestId('publish-toggle-m1'));
    expect(screen.getByTestId('request')).toHaveTextContent('null');
  });
});
