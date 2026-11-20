import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Sidebar, activeItemHref } from '../Sidebar';

function renderSidebar(collapsed = false, initialRoute = '/') {
  return render(
    <MemoryRouter
      initialEntries={[initialRoute]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Sidebar collapsed={collapsed} />
    </MemoryRouter>,
  );
}

describe('Sidebar', () => {
  describe('expanded mode', () => {
    it('renders all top-level sections', () => {
      renderSidebar(false);
      // Direct links
      expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /variables/i })).toBeInTheDocument();
      // Collapsible section buttons
      expect(screen.getByRole('button', { name: /models/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /modeling/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /datasets/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /regions/i })).toBeInTheDocument();
    });

    it('expands Models section on click to show sub-items', async () => {
      renderSidebar(false);
      const modelsBtn = screen.getByRole('button', { name: /models/i });
      await userEvent.click(modelsBtn);
      expect(screen.getByRole('link', { name: /browse models/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /register model/i })).toBeInTheDocument();
    });

    it('auto-expands section when a child route is active', () => {
      renderSidebar(false, '/models');
      // Browse Models link should be visible without clicking
      expect(screen.getByRole('link', { name: /browse models/i })).toBeInTheDocument();
    });

    it('lists Browse and Upload a dataset under Datasets', async () => {
      renderSidebar(false);
      await userEvent.click(screen.getByRole('button', { name: /datasets/i }));

      expect(screen.getByRole('link', { name: 'Browse' })).toHaveAttribute(
        'href',
        '/datasets/browse',
      );
      expect(screen.getByRole('link', { name: 'Upload a dataset' })).toHaveAttribute(
        'href',
        '/datasets/upload',
      );
      expect(screen.queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Search' })).not.toBeInTheDocument();
    });

    it('renders the goal-based group captions', () => {
      renderSidebar(false);
      expect(screen.getByText('Explore')).toBeInTheDocument();
      expect(screen.getByText('Decide')).toBeInTheDocument();
    });
  });

  describe('collapsed mode', () => {
    it('renders icon-only buttons (no text labels for collapsible sections)', () => {
      renderSidebar(true);
      // In collapsed mode, section labels are hidden; only buttons via aria-label
      expect(screen.getByRole('button', { name: /models/i })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /browse models/i })).not.toBeInTheDocument();
    });

    it('hides the group captions', () => {
      renderSidebar(true);
      expect(screen.queryByText('Explore')).not.toBeInTheDocument();
      expect(screen.queryByText('Decide')).not.toBeInTheDocument();
    });
  });

  describe('active item', () => {
    const items = [
      { href: '/etl/register' },
      { href: '/etl/register-piece' },
      { href: '/etl/approvals' },
      { href: '/etl' },
    ];

    it('picks the one item the address belongs to, the most specific', () => {
      expect(activeItemHref(items, '/etl/register-piece')).toBe('/etl/register-piece');
      expect(activeItemHref(items, '/etl/register')).toBe('/etl/register');
      expect(activeItemHref(items, '/etl/approvals/some-spec')).toBe('/etl/approvals');
      expect(activeItemHref(items, '/etl')).toBe('/etl');
      expect(activeItemHref(items, '/etl/some-process')).toBe('/etl');
    });

    it('matches whole path segments only, and nothing outside the section', () => {
      expect(activeItemHref([{ href: '/etl' }], '/etlx')).toBeNull();
      expect(activeItemHref(items, '/datasets')).toBeNull();
    });

    it('lights only the register-a-piece link on its page', async () => {
      const user = userEvent.setup();
      renderSidebar(false, '/etl/register-piece');
      const models = screen.queryByRole('link', { name: 'Register a piece from GitHub' })
        ? null
        : screen.getByRole('button', { name: /models/i });
      if (models) await user.click(models);
      const piece = screen.getByRole('link', { name: 'Register a piece from GitHub' });
      const browse = screen.getByRole('link', { name: 'Browse ETL Processes' });
      expect(piece.className).toMatch(/font-medium/);
      expect(browse.className).not.toMatch(/font-medium/);
      expect(screen.getByRole('link', { name: 'Piece approvals' })).toHaveAttribute(
        'href',
        '/etl/approvals',
      );
    });
  });
});
