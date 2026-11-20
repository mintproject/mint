import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import { CollapsibleCard } from '../CollapsibleCard';

function Harness({ initial = true }: { initial?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <CollapsibleCard
      title="Flood model"
      summary={<span>Running</span>}
      open={open}
      onOpenChange={setOpen}
    >
      <p>card body</p>
    </CollapsibleCard>
  );
}

describe('CollapsibleCard', () => {
  it('shows the title and summary in one header button that reports its state', () => {
    render(<Harness />);
    const header = screen.getByRole('button', { name: /flood model/i });
    expect(header).toHaveTextContent('Running');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('card body')).toBeInTheDocument();
  });

  it('hides the body and flips aria-expanded when the header is clicked, and back', () => {
    render(<Harness />);
    const header = screen.getByRole('button', { name: /flood model/i });
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('card body')).not.toBeInTheDocument();
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('card body')).toBeInTheDocument();
  });

  it('starts closed when told to', () => {
    render(<Harness initial={false} />);
    expect(screen.getByRole('button', { name: /flood model/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('card body')).not.toBeInTheDocument();
  });

  it('turns its animation off for reduced motion', () => {
    render(<Harness />);
    const body = screen.getByText('card body').closest('[data-state]');
    expect(body?.className).toContain('motion-reduce:animate-none');
  });
});
