import { Menu } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/useAuth';

import { cn } from '@/lib/utils';

import { BrandingStrip } from './BrandingStrip';

interface HeaderProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

/**
 * The app bar, painted in the dark chrome the Lit app ships: #222 at 50px, a
 * #7F7F7F rule below it, Roboto 13px.
 *
 * The controls carry their own chrome colours rather than the shadcn variants,
 * which are built for the light surface below: a `primary` button on #222 is a
 * dark shape on a dark bar. The Sidebar stays light.
 */
export function Header({ sidebarCollapsed, onToggleSidebar }: HeaderProps) {
  const { isAuthenticated, user, login, logout } = useAuth();

  return (
    <header
      className={cn(
        'mint-chrome relative flex h-[50px] shrink-0 items-center justify-between px-4',
        'border-b border-[color:var(--mint-chrome-rule)] bg-[color:var(--mint-chrome-bg)]',
        'font-[family-name:var(--mint-chrome-font)] text-[13px] text-[color:var(--mint-chrome-fg)]',
      )}
    >
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleSidebar}
          className="h-8 w-8 text-white hover:bg-white/10 hover:text-white"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <span className="text-base font-medium leading-none">DYNAMO Model Catalog</span>
      </div>

      <BrandingStrip inline />

      <div className="flex items-center gap-3">
        {isAuthenticated ? (
          <>
            <UserAvatar username={user?.username} />
            <span className="hidden text-[13px] text-white/70 sm:inline">{user?.username}</span>
            <Link
              to="/account/credentials"
              className="hidden text-[13px] text-white/70 underline-offset-2 hover:text-white hover:underline sm:inline"
            >
              Saved credentials
            </Link>
            <Button variant="outline" size="sm" onClick={logout} className={chromeButton}>
              Sign Out
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={login} className={chromeButton}>
            Sign In
          </Button>
        )}
      </div>
    </header>
  );
}

/** An outline button that reads on #222 instead of on the light surface. */
const chromeButton =
  'h-8 border-white/40 bg-transparent text-white hover:bg-white/10 hover:text-white';

/** Simple initials-based avatar when no image is available. */
function UserAvatar({ username }: { username?: string }) {
  const initials = username ? username.slice(0, 2).toUpperCase() : '??';

  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full',
        'select-none bg-white/15 text-xs font-medium text-white',
      )}
    >
      {initials}
    </span>
  );
}
