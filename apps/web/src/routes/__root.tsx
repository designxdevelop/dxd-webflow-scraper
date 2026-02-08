import { createRootRouteWithContext, Outlet, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { 
  Globe, 
  History, 
  Settings, 
  LayoutDashboard, 
  LogOut,
  Box,
  ChevronRight
} from "lucide-react";
import { useSession, useSignOut } from "../lib/auth";
import { useEffect, useState } from "react";

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
  const [hoveredNav, setHoveredNav] = useState<string | null>(null);

  const isLoginPage = location.pathname === "/login";

  useEffect(() => {
    if (!isLoading && !session?.user && !isLoginPage) {
      navigate({ to: "/login" });
    }
  }, [isLoading, session, isLoginPage, navigate]);

  if (isLoginPage) {
    return <Outlet />;
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center" style={{ backgroundColor: "#09090b" }}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center gap-4"
        >
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
            className="relative"
          >
            <div className="absolute inset-0 blur-xl" style={{ background: "#6366f1", opacity: 0.5 }} />
            <Box size={32} style={{ color: "#6366f1" }} className="relative" />
          </motion.div>
          <p style={{ color: "#71717a", fontFamily: "JetBrains Mono, monospace" }}>Loading...</p>
        </motion.div>
      </div>
    );
  }

  if (!session?.user) {
    return null;
  }

  return (
    <div className="flex h-screen" style={{ backgroundColor: "#09090b" }}>
      {/* Sidebar */}
      <motion.aside 
        initial={{ x: -20, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="w-64 flex flex-col"
        style={{ 
          backgroundColor: "#09090b",
          borderRight: "1px solid #27272a"
        }}
      >
        {/* Logo Section */}
        <div className="p-6 border-b" style={{ borderColor: "#27272a" }}>
          <Link to="/" className="flex items-center gap-3 group">
            <motion.div 
              whileHover={{ scale: 1.05 }}
              className="relative h-10 w-10 rounded-lg border flex items-center justify-center overflow-hidden"
              style={{
                borderColor: "#27272a",
                background:
                  "radial-gradient(circle at 15% 20%, rgba(34,211,238,0.22), transparent 45%), radial-gradient(circle at 85% 20%, rgba(244,114,182,0.22), transparent 45%), #09090b",
              }}
            >
              <span
                className="relative text-sm font-semibold tracking-[0.24em]"
                style={{
                  fontFamily: "JetBrains Mono, monospace",
                  background:
                    "linear-gradient(90deg, #22d3ee 0%, #93c5fd 38%, #c4b5fd 55%, #f472b6 78%, #fb7185 100%)",
                  WebkitBackgroundClip: "text",
                  color: "transparent",
                  textShadow: "0 0 16px rgba(34,211,238,0.25), 0 0 16px rgba(244,114,182,0.25)",
                }}
              >
                DXD
              </span>
            </motion.div>
            <div>
              <h1 className="text-base font-semibold tracking-tight leading-tight" style={{ color: "#fafafa" }}>
                WF Scraper
              </h1>
            </div>
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-6">
          <ul className="space-y-1">
            <NavItem 
              to="/" 
              icon={<LayoutDashboard size={18} />} 
              label="Dashboard"
              isHovered={hoveredNav === "/"}
              setHovered={setHoveredNav}
            />
            <NavItem 
              to="/sites" 
              icon={<Globe size={18} />} 
              label="Sites"
              isHovered={hoveredNav === "/sites"}
              setHovered={setHoveredNav}
            />
            <NavItem 
              to="/crawls" 
              icon={<History size={18} />} 
              label="Crawls"
              isHovered={hoveredNav === "/crawls"}
              setHovered={setHoveredNav}
            />
            <NavItem 
              to="/settings" 
              icon={<Settings size={18} />} 
              label="Settings"
              isHovered={hoveredNav === "/settings"}
              setHovered={setHoveredNav}
            />
          </ul>
        </nav>

        {/* User Section */}
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.3 }}
          className="p-4 mx-3 mb-3 rounded-lg"
          style={{ 
            backgroundColor: "#18181b",
            border: "1px solid #27272a"
          }}
        >
          <div className="flex items-center gap-3 mb-3">
            {session.user.image ? (
              <img
                src={session.user.image}
                alt={session.user.name || "User"}
                className="w-8 h-8 rounded-lg object-cover"
                style={{ border: "1px solid #27272a" }}
              />
            ) : (
              <div 
                className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold"
                style={{ 
                  background: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
                  color: "white"
                }}
              >
                {(session.user.name || session.user.email || "?").charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate" style={{ color: "#fafafa" }}>
                {session.user.name || session.user.email}
              </p>
              <p className="text-xs font-mono truncate" style={{ color: "#71717a" }}>
                Developer
              </p>
            </div>
          </div>
          <button
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-all"
            style={{ 
              backgroundColor: "#27272a",
              color: "#a1a1aa"
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "#3f3f46";
              e.currentTarget.style.color = "#fafafa";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "#27272a";
              e.currentTarget.style.color = "#a1a1aa";
            }}
          >
            <LogOut size={14} />
            {signOut.isPending ? "Signing out..." : "Sign out"}
          </button>
        </motion.div>
      </motion.aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto" style={{ backgroundColor: "#09090b" }}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2, delay: 0.1 }}
        >
          <Outlet />
        </motion.div>
      </main>
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
  isHovered,
  setHovered,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  isHovered: boolean;
  setHovered: (to: string | null) => void;
}) {
  const location = useLocation();
  const isActive = location.pathname === to || (to !== "/" && location.pathname.startsWith(to));

  return (
    <li>
      <Link
        to={to}
        onMouseEnter={() => setHovered(to)}
        onMouseLeave={() => setHovered(null)}
        className="nav-item flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 relative overflow-hidden"
        style={{
          color: isActive ? "#fafafa" : isHovered ? "#fafafa" : "#a1a1aa",
          backgroundColor: isActive ? "#27272a" : "transparent",
        }}
        activeProps={{ className: "active" }}
      >
        <motion.span
          animate={{ 
            scale: isHovered && !isActive ? 1.1 : 1,
          }}
          transition={{ duration: 0.15 }}
          style={{ color: isActive ? "#818cf8" : undefined }}
        >
          {icon}
        </motion.span>
        <span className="flex-1">{label}</span>
        {isActive && (
          <motion.span
            layoutId="activeIndicator"
            initial={{ opacity: 0, x: -5 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.15 }}
            style={{ color: "#818cf8" }}
          >
            <ChevronRight size={14} />
          </motion.span>
        )}
      </Link>
    </li>
  );
}
