/**
 * Regression test: GetModelTreeWithRegions must select the composite keyFields
 * that the production Apollo cache requires to normalize the junction tables
 * (modelcatalog_configuration_input/output, _configuration_region,
 * _dataset_specification_presentation). MockedProvider does NOT apply these
 * type policies, so the component-level tests cannot catch a missing key — this
 * test writes the real query through the real `typePolicies`.
 *
 * Before the fix, writing this query's result threw Apollo InvariantError #5
 * ("Missing field 'configuration_id' while extracting keyFields ...").
 */
import { gql, InMemoryCache } from '@apollo/client';
import { describe, expect, it } from 'vitest';

import { typePolicies } from '@/lib/apollo-client';
import {
  GetModelTreeWithRegionsDocument,
  type GetModelTreeWithRegionsQuery,
} from '@/graphql/generated/modeling';

function makeCache() {
  return new InMemoryCache({ typePolicies });
}

/** A full result mirroring the GetModelTreeWithRegions selection set, junction keys included. */
const data: GetModelTreeWithRegionsQuery = {
  modelcatalog_software: [
    {
      __typename: 'modelcatalog_software',
      id: 'sw',
      label: 'PIHM',
      versions: [
        {
          __typename: 'modelcatalog_software_version',
          id: 'v',
          label: 'v4',
          configurations: [
            {
              __typename: 'modelcatalog_configuration',
              id: 'cfg',
              label: 'PIHM Flood',
              flow: null,
              regions: [
                {
                  __typename: 'modelcatalog_configuration_region',
                  configuration_id: 'cfg',
                  region_id: 'r',
                  region: { __typename: 'modelcatalog_region', id: 'r', label: 'Texas' },
                },
              ],
              inputs: [
                {
                  __typename: 'modelcatalog_configuration_input',
                  configuration_id: 'cfg',
                  input_id: 'in',
                  is_optional: false,
                  input: {
                    __typename: 'modelcatalog_dataset_specification',
                    id: 'in',
                    label: 'precipitation',
                    has_format: null,
                    presentations: [
                      {
                        __typename: 'modelcatalog_dataset_specification_presentation',
                        dataset_specification_id: 'in',
                        presentation_id: 'vp',
                        presentation: {
                          __typename: 'modelcatalog_variable_presentation',
                          id: 'vp',
                          standard_variable: {
                            __typename: 'modelcatalog_standard_variable',
                            id: 'sv',
                            label: 'precipitation',
                          },
                        },
                      },
                    ],
                  },
                },
              ],
              outputs: [
                {
                  __typename: 'modelcatalog_configuration_output',
                  configuration_id: 'cfg',
                  output_id: 'out',
                  output: {
                    __typename: 'modelcatalog_dataset_specification',
                    id: 'out',
                    label: 'flood extent',
                    has_format: null,
                    presentations: [],
                  },
                },
              ],
              child_configurations: [],
            },
          ],
        },
      ],
    },
  ],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('GetModelTreeWithRegions cache normalization', () => {
  it('normalizes through the real production typePolicies without throwing', () => {
    const cache = makeCache();
    expect(() => cache.writeQuery({ query: GetModelTreeWithRegionsDocument, data })).not.toThrow();

    const read = cache.readQuery<GetModelTreeWithRegionsQuery>({
      query: GetModelTreeWithRegionsDocument,
    });
    const input = read?.modelcatalog_software[0]?.versions[0]?.configurations[0]?.inputs[0]?.input;
    expect(input?.label).toBe('precipitation');
    expect(input?.presentations[0]?.presentation.standard_variable?.label).toBe('precipitation');
  });

  it('a configuration_input junction missing its composite keyFields fails to normalize', () => {
    const cache = makeCache();
    // modelcatalog_configuration_input has keyFields ['configuration_id', 'input_id'];
    // omitting them is exactly the bug this guards against.
    const doc = gql`
      query Bad {
        modelcatalog_configuration_input {
          is_optional
        }
      }
    `;
    expect(() =>
      cache.writeQuery({
        query: doc,
        data: {
          modelcatalog_configuration_input: [
            { __typename: 'modelcatalog_configuration_input', is_optional: false },
          ],
        },
      }),
    ).toThrow();
  });
});
