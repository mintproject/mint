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

  describe('hostile input', () => {
    it('renders a 200 KB line of "[" quickly, and says part was left out', () => {
      const started = Date.now();
      render(<MarkdownLite source={'['.repeat(200_000)} />);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(screen.getByTestId('markdown-truncated')).toBeInTheDocument();
    });

    it('renders 200 KB of "[a](" quickly', () => {
      const started = Date.now();
      render(<MarkdownLite source={'[a]('.repeat(50_000)} />);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('renders a long line of "**a" and of "*" quickly', () => {
      const started = Date.now();
      render(<MarkdownLite source={`${'**a'.repeat(60_000)}\n\n${'* '.repeat(60_000)}`} />);
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it('stops after the line limit and says so', () => {
      const source = Array.from({ length: 6000 }, (_, i) => `- item ${i}`).join('\n');
      render(<MarkdownLite source={source} />);
      expect(screen.getAllByRole('listitem').length).toBeLessThanOrEqual(3000);
      expect(screen.getByTestId('markdown-truncated')).toBeInTheDocument();
    });

    it('does not say anything was left out for an ordinary report', () => {
      render(<MarkdownLite source={'# A\n\nshort'} />);
      expect(screen.queryByTestId('markdown-truncated')).not.toBeInTheDocument();
    });
  });

  describe('links', () => {
    it('shows the host beside a link whose words differ from its address', () => {
      render(<MarkdownLite source="[your bank](https://evil.example/login)" />);
      const link = screen.getByRole('link', { name: 'your bank' });
      expect(link.parentElement).toHaveTextContent('your bank (evil.example)');
    });

    it('adds no host for a link whose words are its address', () => {
      const { container } = render(
        <MarkdownLite source="[https://example.com/a](https://example.com/a)" />,
      );
      expect(container).not.toHaveTextContent('(example.com)');
    });
  });
});
