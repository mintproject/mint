import { describe, expect, it } from 'vitest';

import type { PlanPublisher } from '@/lib/ensemble-manager';
import { priorPublish, selectionFromPrior } from '../publish-outputs';

const encode = (plan: unknown) =>
  `em_${btoa(JSON.stringify(plan)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`;

const publisher: PlanPublisher = {
  transform_spec_id: 'spec-1',
  name: 'Publish',
  catalog_tokens: ['ckan', 'stac'],
  catalog_options: [['ckan', 'stac'], ['ckan']],
  parameters: [{ name: 'title', default: 'My run' }],
  can_publish: { ok: true, reason: null },
};

describe('priorPublish', () => {
  it('reads the catalogs and output the earlier plan asked to publish', () => {
    expect(
      priorPublish(encode({ publish: ['ckan'], post_model_adapter: { model_output_key: 'cbb' } })),
    ).toEqual({ tokens: ['ckan'], outputKey: 'cbb' });
  });

  it('is null for a plan that published nothing, or an id it cannot read', () => {
    expect(priorPublish(encode({ thread_id: 't' }))).toBeNull();
    expect(priorPublish('em_!!!.sig')).toBeNull();
    expect(priorPublish('svo_abc')).toBeNull();
    expect(priorPublish(undefined)).toBeNull();
  });
});

describe('selectionFromPrior', () => {
  it('picks the publisher offering exactly those catalogs, with its parameter defaults', () => {
    expect(selectionFromPrior([publisher], { tokens: ['ckan'] })).toEqual({
      transformSpecId: 'spec-1',
      values: { title: 'My run' },
      tokens: ['ckan'],
    });
  });

  it('is null when no publisher offers them any more', () => {
    expect(selectionFromPrior([publisher], { tokens: ['zenodo'] })).toBeNull();
    expect(selectionFromPrior([publisher], null)).toBeNull();
  });
});
