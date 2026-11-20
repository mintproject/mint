import { describe, expect, it } from 'vitest';
import type { GetModelTreeWithRegionsQuery, ModelConfigInfo } from '@/graphql/generated/modeling';
import { rankSuggestionsByUse, suggestionUseText } from '@/lib/datasets/upload-preview';

const SV = 'https://w3id.org/okn/i/mint/';

function input(id: string, variable: string, format: string | null) {
  return {
    configuration_id: 'c',
    input_id: id,
    is_optional: false,
    input: {
      id,
      label: id,
      has_format: format,
      presentations: [
        {
          dataset_specification_id: id,
          presentation_id: `${id}-p`,
          presentation: {
            id: `${id}-p`,
            standard_variable: { id: SV + variable, label: variable },
          },
        },
      ],
    },
  };
}

function config(id: string, inputs: ReturnType<typeof input>[], flow = false): ModelConfigInfo {
  return {
    id,
    label: id,
    flow: flow ? { configuration_id: id, thread_bindings_json: null } : null,
    regions: [],
    inputs,
    outputs: [],
    child_configurations: [],
  } as unknown as ModelConfigInfo;
}

const tree: GetModelTreeWithRegionsQuery = {
  modelcatalog_software: [
    {
      id: 's',
      label: 's',
      versions: [
        {
          id: 'v',
          label: 'v',
          configurations: [
            config(
              'Dictionary flow',
              [input('corpus', 'document_collection__text', 'directory')],
              true,
            ),
            config(
              'Narrative flow',
              [input('corpus2', 'document_collection__text', 'directory')],
              true,
            ),
            config('HAND', [input('dem', 'land_surface__elevation', 'tif')]),
            config('Narratives model', [input('nlp', 'corpus_nlp', null)]),
          ],
        },
      ],
    },
  ],
};

// The semantic order the service returned for "RGV Transcripts — oral histories".
const hits = [
  { id: SV + 'corpus_nlp', label: 'corpus_nlp' },
  {
    id: SV + 'document_collection_narrative_frame__description',
    label: 'document_collection_narrative_frame__description',
  },
  { id: SV + 'land_surface__elevation', label: 'land_surface__elevation' },
  { id: SV + 'document_collection__text', label: 'document_collection__text' },
];

const labels = (ranked: { item: { label: string } }[]) => ranked.map((r) => r.item.label);

describe('rankSuggestionsByUse', () => {
  it('puts the variable a flow input accepts these files under first', () => {
    const ranked = rankSuggestionsByUse(tree, hits, [{ name: 'transcript.json' }]);
    expect(labels(ranked)).toEqual([
      'document_collection__text',
      'corpus_nlp',
      'land_surface__elevation',
      'document_collection_narrative_frame__description',
    ]);
    expect(ranked.map((r) => r.fit)).toEqual([0, 1, 2, 3]);
  });

  it('keeps the semantic order among variables that fit equally', () => {
    const ranked = rankSuggestionsByUse(tree, hits, []);
    // No files yet: anything an input takes ranks above what nothing takes.
    expect(labels(ranked)).toEqual([
      'corpus_nlp',
      'land_surface__elevation',
      'document_collection__text',
      'document_collection_narrative_frame__description',
    ]);
  });

  it('ranks nothing without the model tree but keeps every suggestion', () => {
    expect(labels(rankSuggestionsByUse(undefined, hits, []))).toEqual(hits.map((h) => h.label));
  });
});

describe('suggestionUseText', () => {
  it('says who takes the variable and when the format is wrong', () => {
    const ranked = rankSuggestionsByUse(tree, hits, [{ name: 'transcript.json' }]);
    expect(ranked.map(suggestionUseText)).toEqual([
      'Input to 2 flows',
      'Input to 1 model',
      'Input to 1 model, but not in this file format',
      'No registered flow or model takes this as an input',
    ]);
  });
});
