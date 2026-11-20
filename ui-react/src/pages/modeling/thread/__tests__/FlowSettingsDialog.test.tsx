import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { FlowSettingsDialog, type FlowRunGate } from '../FlowSettingsDialog';

function open(gate: FlowRunGate) {
  render(
    <MemoryRouter>
      <FlowSettingsDialog gate={gate} onConfirm={vi.fn()} onCancel={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('FlowSettingsDialog', () => {
  it('writes a fixed value as words', () => {
    open({ settings: { defaults: { chat_kind: 'openai_compatible' }, links: [] } });
    expect(screen.getByTestId('flow-settings-defaults')).toHaveTextContent(
      'chat kind: openai_compatible',
    );
  });

  it('writes a linked setting with the step names, never as JSON', () => {
    open({
      settings: {
        defaults: {},
        links: [
          { step: 3, setting: 'lexicon_uri', from: { step: 2, output: 0 } },
          { step: 4, setting: 'taxonomy_uri', from: { step: 2, output: 1 } },
        ],
      },
      steps: [
        { step: '2', name: 'Sensemaking: draft lexicon', depends_on: [] },
        { step: '3', name: 'Sensemaking: score lexicon', depends_on: ['2'] },
      ],
    });
    const links = screen.getByTestId('flow-settings-links');
    expect(links).toHaveTextContent(
      "Step 3, Sensemaking: score lexicon - lexicon uri: taken from step 2's output 1",
    );
    expect(links).toHaveTextContent("Step 4 - taxonomy uri: taken from step 2's output 2");
    expect(links.textContent).not.toMatch(/[{}"]/);
  });

  it('says only that the flow sets a setting when the shape is unknown', () => {
    open({
      settings: {
        defaults: {},
        links: [{ setting: 'region', via: { a: 1 } }, 'odd'],
      },
    });
    const links = screen.getByTestId('flow-settings-links');
    expect(links).toHaveTextContent('region: set by the flow');
    expect(links).toHaveTextContent('A setting: set by the flow');
    expect(links.textContent).not.toMatch(/[{}"]/);
  });
});
