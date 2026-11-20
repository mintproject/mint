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

  it('lists every value the author chose, hidden and fixed ones and web addresses too', () => {
    // The plan lists the author's values whatever the form shows, so the runner reads
    // each one before accepting. Nothing here is filtered by visibility.
    open({
      settings: {
        defaults: {
          taxonomy_uri: 'https://elsewhere.example/taxonomy.json',
          chat_kind: 'openai_compatible',
          max_files: 5,
        },
        links: [],
      },
    });
    const defaults = screen.getByTestId('flow-settings-defaults');
    expect(defaults).toHaveTextContent('taxonomy uri: https://elsewhere.example/taxonomy.json');
    expect(defaults).toHaveTextContent('chat kind: openai_compatible');
    expect(defaults).toHaveTextContent('max files: 5');
    expect(screen.getByRole('button', { name: 'Accept and run' })).toBeDisabled();
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
