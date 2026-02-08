import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ApiError, sitesApi, crawlsApi } from "@/lib/api";
import { Globe, Clock, ArrowRight, Activity, TrendingUp, Layers, Plus } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.3,
      ease: "easeOut" as const,
    },
  },
};

function DashboardPage() {
  const navigate = useNavigate();
  const { data: sitesData, error: sitesError } = useQuery({
    queryKey: ["sites"],
    queryFn: sitesApi.list,
    refetchInterval: 10000,
  });

  const { data: crawlsData, error: crawlsError } = useQuery({
    queryKey: ["crawls", { limit: 5 }],
    queryFn: () => crawlsApi.list({ limit: 5 }),
    refetchInterval: 5000,
  });

  useEffect(() => {
    const authError = [sitesError, crawlsError].find(
      (err) => err instanceof ApiError && err.status === 401
    );
    if (authError) {
      navigate({ to: "/login" });
    }
  }, [sitesError, crawlsError, navigate]);

  const sites = sitesData?.sites || [];
  const recentCrawls = crawlsData?.crawls || [];

  const runningCrawls = recentCrawls.filter((c) => c.status === "running").length;
  const completedCrawls = recentCrawls.filter((c) => c.status === "completed").length;

  const successRate = recentCrawls.length > 0
    ? Math.round((completedCrawls / recentCrawls.length) * 100)
    : 0;

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      {/* Header Section */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mb-6 md:mb-8"
      >
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-xs font-mono" style={{ color: "#6366f1" }}>
                dashboard/overview
              </span>
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono" style={{ 
                backgroundColor: "rgba(34, 197, 94, 0.1)",
                color: "#22c55e"
              }}>
                <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: "#22c55e" }} />
                online
              </div>
            </div>
            <h1 className="text-xl md:text-2xl font-bold mb-1" style={{ color: "#fafafa" }}>
              Dashboard
            </h1>
            <p className="text-sm" style={{ color: "#71717a" }}>
              Manage <span className="font-mono" style={{ color: "#a1a1aa" }}>{sites.length}</span> sites
              {runningCrawls > 0 && (
                <>, <span className="font-mono" style={{ color: "#3b82f6" }}>{runningCrawls}</span> running</>
              )}
            </p>
          </div>

          <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="shrink-0">
            <Link
              to="/sites/new"
              className="btn-primary touch-target-sm"
              aria-label="Create new site"
            >
              <Plus size={16} />
              <span className="hidden sm:inline">New Site</span>
              <span className="sm:hidden">New</span>
            </Link>
          </motion.div>
        </div>
      </motion.div>

      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-6 md:mb-8">
          <StatCard
            title="Total Sites"
            value={sites.length}
            subtitle="Configured"
            icon={<Globe size={18} />}
            color="#22c55e"
          />
          <StatCard
            title="Active Crawls"
            value={runningCrawls}
            subtitle="In progress"
            icon={<Activity size={18} />}
            color="#3b82f6"
          />
          <StatCard
            title="Success Rate"
            value={`${successRate}%`}
            subtitle="Last 5 crawls"
            icon={<TrendingUp size={18} />}
            color="#a855f7"
          />
          <StatCard
            title="Total Crawls"
            value={recentCrawls.length}
            subtitle="Completed"
            icon={<Layers size={18} />}
            color="#f59e0b"
          />
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
          {/* Sites Section */}
          <motion.div variants={itemVariants}>
            <div className="card-dark p-4 md:p-6">
              <div className="flex items-center justify-between mb-4 md:mb-6">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg" style={{ backgroundColor: "rgba(34, 197, 94, 0.1)" }}>
                    <Globe size={18} style={{ color: "#22c55e" }} />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold" style={{ color: "#fafafa" }}>Sites</h2>
                    <p className="text-xs font-mono hidden sm:block" style={{ color: "#71717a" }}>Monitored</p>
                  </div>
                </div>
                <Link
                  to="/sites"
                  className="btn-ghost btn-sm touch-target-sm"
                  aria-label="View all sites"
                >
                  View all
                  <ArrowRight size={14} />
                </Link>
              </div>

              {sites.length === 0 ? (
                <EmptyState icon={<Globe size={24} />} text="No sites configured" />
              ) : (
                <div className="space-y-2">
                  {sites.slice(0, 5).map((site) => (
                    <motion.div
                      key={site.id}
                      whileHover={{ x: 2 }}
                      transition={{ duration: 0.15 }}
                    >
                      <Link
                        to="/sites/$siteId"
                        params={{ siteId: site.id }}
                        className="flex items-center justify-between p-3 rounded-lg transition-colors touch-target-sm"
                        style={{ backgroundColor: "#18181b" }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = "#27272a";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = "#18181b";
                        }}
                        aria-label={`Site ${site.name}`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div
                            className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center text-sm font-bold font-mono"
                            style={{
                              backgroundColor: "#27272a",
                              color: "#818cf8",
                            }}
                          >
                            {site.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-sm truncate" style={{ color: "#fafafa" }}>
                              {site.name}
                            </p>
                            <p className="text-xs font-mono truncate hidden sm:block" style={{ color: "#71717a" }}>
                              {site.url}
                            </p>
                          </div>
                        </div>
                        {site.lastCrawl ? (
                          <StatusBadge status={site.lastCrawl.status || "unknown"} />
                        ) : (
                          <span className="text-xs font-mono shrink-0" style={{ color: "#52525b" }}>never</span>
                        )}
                      </Link>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>

          {/* Recent Crawls Section */}
          <motion.div variants={itemVariants}>
            <div className="card-dark p-4 md:p-6">
              <div className="flex items-center justify-between mb-4 md:mb-6">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg" style={{ backgroundColor: "rgba(59, 130, 246, 0.1)" }}>
                    <Clock size={18} style={{ color: "#3b82f6" }} />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold" style={{ color: "#fafafa" }}>Recent Crawls</h2>
                    <p className="text-xs font-mono hidden sm:block" style={{ color: "#71717a" }}>Latest activity</p>
                  </div>
                </div>
                <Link
                  to="/crawls"
                  className="btn-ghost btn-sm touch-target-sm"
                  aria-label="View all crawls"
                >
                  View all
                  <ArrowRight size={14} />
                </Link>
              </div>

              {recentCrawls.length === 0 ? (
                <EmptyState icon={<Clock size={24} />} text="No crawls yet" />
              ) : (
                <div className="space-y-2">
                  {recentCrawls.map((crawl) => (
                    <motion.div
                      key={crawl.id}
                      whileHover={{ x: 2 }}
                      transition={{ duration: 0.15 }}
                    >
                      <Link
                        to="/crawls/$crawlId"
                        params={{ crawlId: crawl.id }}
                        className="block p-3 rounded-lg transition-colors touch-target-sm"
                        style={{ backgroundColor: "#18181b" }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = "#27272a";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = "#18181b";
                        }}
                        aria-label={`Crawl for ${crawl.site?.name || "Unknown"}`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <p className="font-medium text-sm truncate mr-2" style={{ color: "#fafafa" }}>
                            {crawl.site?.name || "Unknown"}
                          </p>
                          <StatusBadge status={crawl.status || "unknown"} />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-mono" style={{ color: "#71717a" }}>
                            {crawl.succeededPages ?? 0}/{crawl.totalPages ?? "?"} pages
                          </span>
                          <span className="text-xs font-mono" style={{ color: "#52525b" }}>
                            {crawl.startedAt
                              ? new Date(crawl.startedAt).toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                })
                              : "pending"}
                          </span>
                        </div>
                        {crawl.totalPages && crawl.totalPages > 0 && (
                          <div className="mt-2 progress-dark">
                            <div
                              className="progress-dark-fill"
                              style={{
                                width: `${((crawl.succeededPages || 0) / crawl.totalPages) * 100}%`,
                              }}
                            />
                          </div>
                        )}
                      </Link>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
}

function StatCard({
  title,
  value,
  subtitle,
  icon,
  color,
}: {
  title: string;
  value: string | number;
  subtitle: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <motion.div
      variants={itemVariants}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
      className="card-dark p-4 md:p-5"
    >
      <div className="flex items-start justify-between mb-2 md:mb-3">
        <div
          className="p-2 rounded-lg"
          style={{
            backgroundColor: `${color}15`,
          }}
        >
          <span style={{ color }}>{icon}</span>
        </div>
      </div>

      <div>
        <p className="text-xl md:text-2xl font-bold font-mono mb-0.5" style={{ color: "#fafafa" }}>
          {value}
        </p>
        <p className="text-xs md:text-sm font-medium mb-0.5" style={{ color: "#a1a1aa" }}>
          {title}
        </p>
        <p className="text-xs font-mono hidden sm:block" style={{ color: "#71717a" }}>
          {subtitle}
        </p>
      </div>
    </motion.div>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div 
      className="text-center py-8 rounded-lg"
      style={{ backgroundColor: "#18181b", border: "1px dashed #27272a" }}
    >
      <div className="mb-2" style={{ color: "#52525b" }}>{icon}</div>
      <p className="text-xs font-mono" style={{ color: "#71717a" }}>{text}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; color: string }> = {
    pending: {
      bg: "rgba(245, 158, 11, 0.15)",
      color: "#fbbf24",
    },
    running: {
      bg: "rgba(59, 130, 246, 0.15)",
      color: "#60a5fa",
    },
    completed: {
      bg: "rgba(34, 197, 94, 0.15)",
      color: "#4ade80",
    },
    failed: {
      bg: "rgba(239, 68, 68, 0.15)",
      color: "#f87171",
    },
    cancelled: {
      bg: "rgba(113, 113, 122, 0.15)",
      color: "#a1a1aa",
    },
  };

  const style = styles[status] || styles.pending;

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono"
      style={{
        backgroundColor: style.bg,
        color: style.color,
      }}
    >
      <span
        className={`w-1 h-1 rounded-full ${status === "running" ? "animate-pulse" : ""}`}
        style={{ 
          backgroundColor: style.color,
          boxShadow: status === "running" ? `0 0 6px ${style.color}` : undefined
        }}
      />
      {status}
    </span>
  );
}
