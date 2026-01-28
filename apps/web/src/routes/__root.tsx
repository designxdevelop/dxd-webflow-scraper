import { createRootRouteWithContext, Outlet, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { Globe, History, Settings, LayoutDashboard, LogOut } from "lucide-react";
import { useSession, useSignOut } from "../lib/auth";
import { useEffect } from "react";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session, isLoading } = useSession();
  const signOut = useSignOut();

  const isLoginPage = location.pathname === "/login";

  // Redirect to login if not authenticated (except on login page)
  useEffect(() => {
    if (!isLoading && !session?.user && !isLoginPage) {
      navigate({ to: "/login" });
    }
  }, [isLoading, session, isLoginPage, navigate]);

  // Show login page without layout
  if (isLoginPage) {
    return <Outlet />;
  }

  // Show loading while checking auth
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Don't render layout if not authenticated
  if (!session?.user) {
    return null;
  }

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-card flex flex-col">
        <div className="p-6 border-b border-border">
          <h1 className="text-xl font-bold text-foreground">Webflow Scraper</h1>
          <p className="text-sm text-muted-foreground mt-1">Site archiver dashboard</p>
        </div>

        <nav className="flex-1 p-4">
          <ul className="space-y-1">
            <NavItem to="/" icon={<LayoutDashboard size={18} />} label="Dashboard" />
            <NavItem to="/sites" icon={<Globe size={18} />} label="Sites" />
            <NavItem to="/crawls" icon={<History size={18} />} label="Crawls" />
            <NavItem to="/settings" icon={<Settings size={18} />} label="Settings" />
          </ul>
        </nav>

        {/* User info and sign out */}
        <div className="p-4 border-t border-border">
          <div className="flex items-center gap-3 mb-3">
            {session.user.image && (
              <img
                src={session.user.image}
                alt={session.user.name || "User"}
                className="w-8 h-8 rounded-full"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                {session.user.name || session.user.email}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {session.user.email}
              </p>
            </div>
          </div>
          <button
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
          >
            <LogOut size={16} />
            {signOut.isPending ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <li>
      <Link
        to={to}
        className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground [&.active]:bg-primary [&.active]:text-primary-foreground"
        activeProps={{ className: "active" }}
      >
        {icon}
        {label}
      </Link>
    </li>
  );
}
