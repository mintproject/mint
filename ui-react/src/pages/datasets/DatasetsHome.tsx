import { Link } from 'react-router-dom';
import { Database, Search, Upload } from 'lucide-react';

import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/datasets/browse',
    icon: Database,
    label: 'Browse Datasets',
  },
  {
    href: '/datasets/search',
    icon: Search,
    label: 'Search Datasets',
  },
  {
    href: '/datasets/upload',
    icon: Upload,
    label: 'Upload a dataset',
  },
];

/** Datasets overview page with icon-grid sub-navigation. */
export function DatasetsHome() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Datasets</h2>
        <p className="mt-1 text-muted-foreground">Browse and search datasets.</p>
      </div>

      <div
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        role="navigation"
        aria-label="Datasets sub-navigation"
      >
        {NAV_ITEMS.map((item) => (
          <NavCard key={item.href} item={item} />
        ))}
      </div>
    </div>
  );
}

function NavCard({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.href}
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border bg-card p-6',
        'text-card-foreground shadow-sm transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <Icon className="h-8 w-8 text-muted-foreground" />
      <span className="text-sm font-medium">{item.label}</span>
    </Link>
  );
}
