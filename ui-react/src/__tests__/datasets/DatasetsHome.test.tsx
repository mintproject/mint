import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DatasetsHome } from '../../pages/datasets/DatasetsHome';
import { renderWithProviders } from '../../test/utils/render';

describe('DatasetsHome', () => {
  it('renders the page heading', () => {
    renderWithProviders(<DatasetsHome />);
    expect(screen.getByText('Datasets')).toBeInTheDocument();
  });

  it('renders sub-navigation links', () => {
    renderWithProviders(<DatasetsHome />);
    expect(screen.getByRole('link', { name: /browse datasets/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /search datasets/i })).toBeInTheDocument();
  });

  it('links to the upload page', () => {
    renderWithProviders(<DatasetsHome />);
    expect(screen.getByRole('link', { name: 'Upload a dataset' })).toHaveAttribute(
      'href',
      '/datasets/upload',
    );
  });

  it('links point to correct hrefs', () => {
    renderWithProviders(<DatasetsHome />);
    const browseLink = screen.getByRole('link', { name: /browse datasets/i });
    const searchLink = screen.getByRole('link', { name: /search datasets/i });

    expect(browseLink).toHaveAttribute('href', '/datasets/browse');
    expect(searchLink).toHaveAttribute('href', '/datasets/search');
  });

  it('renders the nav region with accessible label', () => {
    renderWithProviders(<DatasetsHome />);
    expect(
      screen.getByRole('navigation', { name: /datasets sub-navigation/i }),
    ).toBeInTheDocument();
  });
});
