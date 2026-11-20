import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MarkdownLite } from '../MarkdownLite';

describe('MarkdownLite', () => {
  it('renders headings, paragraphs, lists and inline marks as elements', () => {
    render(
      <MarkdownLite
        source={
          '# Report\n\nSome **bold** and *soft* and `code` text.\n\n- one\n- two\n\n1. first\n2. second\n'
        }
      />,
    );
    expect(screen.getByRole('heading', { name: 'Report' })).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('soft').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('renders a pipe table with its header', () => {
    render(<MarkdownLite source={'| name | n |\n| --- | --- |\n| a | 1 |\n| b | 2 |'} />);
    expect(screen.getByRole('columnheader', { name: 'name' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'b' })).toBeInTheDocument();
  });

  it('links only http(s) addresses, in a new tab', () => {
    render(<MarkdownLite source="[ok](https://example.com) and [bad](javascript:alert(1))" />);
    const link = screen.getByRole('link', { name: 'ok' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: 'bad' })).not.toBeInTheDocument();
    expect(screen.getByText(/bad/)).toBeInTheDocument();
  });

  it('never turns text into HTML', () => {
    const { container } = render(<MarkdownLite source={'<img src=x onerror=alert(1)> <b>x</b>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)>');
  });

  it('keeps fenced code as it was', () => {
    const { container } = render(<MarkdownLite source={'```\n# not a heading\n```'} />);
    expect(container.querySelector('pre')).toHaveTextContent('# not a heading');
  });
});
