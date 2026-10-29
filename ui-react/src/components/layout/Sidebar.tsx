import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  BookOpen,
  ChevronRight,
  Database,
  FlaskConical,
  Home,
  Map,
  Variable,
  Workflow,
} from 'lucide-react';

import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface SidebarProps {
  collapsed: boolean;
}

interface NavSection {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** If set, this section is a direct link (no sub-items). */
  href?: string;
  /** Sub-navigation items. */
  items?: { href: string; label: string }[];
}

interface NavGroup {
  /** Caption shown above the group; omit for the pinned, ungrouped items (Home). */
  caption?: string;
  sections: NavSection[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    sections: [{ label: 'Home', icon: Home, href: '/' }],
  },
  {
    caption: 'Explore',
    sections: [
      {
        label: 'Models',
        icon: FlaskConical,
        items: [
          { href: '/models', label: 'Browse Models' },
          { href: '/models/register', label: 'Register Model Configuration' },
          { href: '/etl/register', label: 'Register ETL Process' },
          { href: '/etl', label: 'Browse ETL Processes' },
        ],
      },
      {
        label: 'Datasets',
        icon: Database,
        items: [{ href: '/datasets/browse', label: 'Browse' }],
      },
      {
        label: 'Regions',
        icon: Map,
        items: [
          { href: '/regions', label: 'Overview' },
          { href: '/regions/editor', label: 'Region Editor' },
        ],
      },
      {
        label: 'Variables',
        icon: Variable,
        href: '/variables',
      },
    ],
  },
  {
    caption: 'Decide',
    sections: [
      {
        label: 'Modeling',
        icon: Workflow,
        items: [
          { href: '/modeling', label: 'Overview' },
          {
            href: '/modeling/problem-statements',
            label: 'Problem Statements',
          },
        ],
      },
    ],
  },
];

export function Sidebar({ collapsed }: SidebarProps) {
  const location = useLocation();

  return (
    <aside
      className={cn(
        'flex flex-col border-r bg-background transition-all duration-200',
        collapsed ? 'w-14' : 'w-60',
      )}
      aria-label="Main navigation"
    >
      <nav className="flex flex-col p-2">
        {NAV_GROUPS.map((group, index) => (
          <div key={group.caption ?? index} className="flex flex-col gap-1">
            {index > 0 && <Separator className="my-2" />}
            {!collapsed && group.caption && (
              <p className="px-2 pb-1 pt-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.caption}
              </p>
            )}
            {group.sections.map((section) =>
              section.href ? (
                <DirectLink
                  key={section.label}
                  section={section}
                  collapsed={collapsed}
                  active={location.pathname === section.href}
                />
              ) : (
                <SectionGroup
                  key={section.label}
                  section={section}
                  collapsed={collapsed}
                  currentPath={location.pathname}
                />
              ),
            )}
          </div>
        ))}
        <Separator className="my-2" />
        <GuideLink collapsed={collapsed} />
      </nav>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DirectLink({
  section,
  collapsed,
  active,
}: {
  section: NavSection;
  collapsed: boolean;
  active: boolean;
}) {
  const Icon = section.icon;
  return (
    <Link
      to={section.href!}
      title={collapsed ? section.label : undefined}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span>{section.label}</span>}
    </Link>
  );
}

/**
 * The user guide is a separate static site served at /docs/ by the container's
 * Nginx, not a router route, so this is a plain anchor: a <Link> would hand the
 * path to React Router, which renders the app's not-found page. It opens in a
 * new tab to keep the user's place in the app. Vite dev and Vercel builds do
 * not include the guide, so the link 404s there.
 */
function GuideLink({ collapsed }: { collapsed: boolean }) {
  return (
    <a
      href="/docs/"
      target="_blank"
      rel="noreferrer"
      title={collapsed ? 'User Guide' : undefined}
      className="flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <BookOpen className="h-4 w-4 shrink-0" />
      {!collapsed && <span>User Guide</span>}
    </a>
  );
}

function SectionGroup({
  section,
  collapsed,
  currentPath,
}: {
  section: NavSection;
  collapsed: boolean;
  currentPath: string;
}) {
  const Icon = section.icon;
  const isAnyChildActive = section.items?.some((item) => currentPath.startsWith(item.href));

  const [open, setOpen] = useState(isAnyChildActive ?? false);

  if (collapsed) {
    // In collapsed mode, show just the icon and no expansion
    return (
      <button
        type="button"
        title={section.label}
        className={cn(
          'flex items-center justify-center rounded-md p-2 text-sm transition-colors',
          'hover:bg-accent hover:text-accent-foreground',
          isAnyChildActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
        )}
        aria-label={section.label}
      >
        <Icon className="h-4 w-4 shrink-0" />
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm font-medium transition-colors',
          'hover:bg-accent hover:text-accent-foreground',
          isAnyChildActive ? 'text-foreground' : 'text-muted-foreground',
        )}
        aria-expanded={open}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">{section.label}</span>
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
      </button>

      {open && (
        <div className="ml-6 mt-0.5 flex flex-col gap-0.5">
          {section.items?.map((item) => (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                'rounded-md px-2 py-1.5 text-sm transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                currentPath.startsWith(item.href)
                  ? 'bg-accent/60 font-medium text-accent-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
