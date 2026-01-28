import { createRootRouteWithContext, Outlet, Link } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { Globe, History, Settings, LayoutDashboard } from "lucide-react";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
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

        <div className="p-4 border-t border-border text-xs text-muted-foreground">
          <p>DXD Internal Tool</p>
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
