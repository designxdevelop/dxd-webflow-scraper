import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ApiError, sitesApi } from "@/lib/api";
import { formatToMountainDate } from "@/lib/date";
import { SiteFavicon } from "@/components/site-favicon";
import { Plus, Globe, Trash2, Play, ExternalLink, Search } from "lucide-react";
import { useEffect } from "react";

export const Route = createFileRoute("/sites/")({
  component: SitesPage,
});

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.03,
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

function SitesPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["sites"],
    queryFn: sitesApi.list,
    refetchInterval: 10000,
  });

  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) {
      navigate({ to: "/login" });
    }
  }, [error, navigate]);

  const deleteMutation = useMutation({
    mutationFn: sitesApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sites"] });
    },
  });

  const startCrawlMutation = useMutation({
    mutationFn: sitesApi.startCrawl,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      queryClient.invalidateQueries({ queryKey: ["crawls"] });
    },
  });

  const sites = data?.sites || [];

  const formatHostname = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mb-6 md:mb-8"
      >
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <span className="text-xs font-mono" style={{ color: "#6366f1" }}>
              sites/manage
            </span>
            <h1 className="text-xl md:text-2xl font-bold mt-1 mb-1" style={{ color: "#fafafa" }}>
              Sites
            </h1>
            <p className="text-sm" style={{ color: "#71717a" }}>
              Manage and configure Webflow sites to archive
            </p>
          </div>

          <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="shrink-0">
            <Link to="/sites/new" className="btn-primary touch-target-sm" aria-label="Add new site">
              <Plus size={16} />
              <span className="hidden sm:inline">Add Site</span>
              <span className="sm:hidden">Add</span>
            </Link>
          </motion.div>
        </div>
      </motion.div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
            className="w-8 h-8 border-2 rounded-full"
            style={{ borderColor: "#27272a", borderTopColor: "#6366f1" }}
          />
        </div>
      ) : isError ? (
        <div className="card-dark p-6">
          <p className="text-sm font-medium" style={{ color: "#ef4444" }}>
            {error instanceof Error ? error.message : "Failed to load sites"}
          </p>
          <p className="text-xs mt-2" style={{ color: "#71717a" }}>
            Check API auth/session and database migrations.
          </p>
        </div>
      ) : sites.length === 0 ? (
        <EmptyState />
      ) : (
        <div>
          {/* Filters */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-4 mb-4 md:mb-6"
          >
            <div className="flex-1 relative max-w-sm">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 z-10 pointer-events-none" style={{ color: "#71717a" }} />
              <input
                type="text"
                placeholder="Search sites..."
                className="input-dark touch-target-sm"
                style={{ paddingLeft: "40px" }}
                aria-label="Search sites"
              />
            </div>
          </motion.div>

          {/* Desktop: Sites Table */}
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="card-dark overflow-hidden hidden md:block"
          >
            <table className="table-dark">
              <thead>
                <tr>
                  <th>Site</th>
                  <th>URL</th>
                  <th>Last Crawl</th>
                  <th>Schedule</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <motion.tr
                    key={site.id}
                    variants={itemVariants}
                    className="group"
                  >
                    <td>
                      <Link
                        to="/sites/$siteId"
                        params={{ siteId: site.id }}
                        className="flex items-center gap-3"
                      >
                        <SiteFavicon siteName={site.name} siteUrl={site.url} className="w-8 h-8" />
                        <span className="font-medium text-sm group-hover:underline" style={{ color: "#fafafa" }}>
                          {site.name}
                        </span>
                      </Link>
                    </td>
                    <td>
                      <a
                        href={site.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-mono flex items-center gap-1 transition-colors hover:opacity-80"
                        style={{ color: "#71717a" }}
                      >
                        {formatHostname(site.url)}
                        <ExternalLink size={12} />
                      </a>
                    </td>
                    <td>
                      {site.lastCrawl ? (
                        <div className="flex items-center gap-2">
                          <StatusIndicator status={site.lastCrawl.status || "unknown"} />
                          <span className="text-xs font-mono" style={{ color: "#71717a" }}>
                            {formatToMountainDate(site.lastCrawl.createdAt)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs font-mono" style={{ color: "#52525b" }}>never</span>
                      )}
                    </td>
                    <td>
                      {site.scheduleEnabled ? (
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono"
                          style={{
                            backgroundColor: "rgba(34, 197, 94, 0.1)",
                            color: "#22c55e",
                          }}
                        >
                          <ClockIcon size={12} />
                          {site.scheduleCron}
                        </span>
                      ) : (
                        <span className="text-xs font-mono" style={{ color: "#52525b" }}>disabled</span>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        <motion.button
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          onClick={() => startCrawlMutation.mutate(site.id)}
                          disabled={startCrawlMutation.isPending}
                          className="p-2 rounded-md transition-colors touch-target-sm"
                          style={{ color: "#22c55e" }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(34, 197, 94, 0.1)")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                          aria-label={`Start crawl for ${site.name}`}
                        >
                          <Play size={14} fill="currentColor" />
                        </motion.button>
                        <motion.button
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          onClick={() => {
                            if (confirm("Delete this site?")) {
                              deleteMutation.mutate(site.id);
                            }
                          }}
                          disabled={deleteMutation.isPending}
                          className="p-2 rounded-md transition-colors touch-target-sm"
                          style={{ color: "#ef4444" }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(239, 68, 68, 0.1)")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                          aria-label={`Delete ${site.name}`}
                        >
                          <Trash2 size={14} />
                        </motion.button>
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </motion.div>

          {/* Mobile: Site Cards */}
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="md:hidden space-y-3"
          >
            {sites.map((site) => (
              <motion.div
                key={site.id}
                variants={itemVariants}
                className="card-dark p-4"
              >
                <div className="flex items-start justify-between mb-3">
                  <Link
                    to="/sites/$siteId"
                    params={{ siteId: site.id }}
                    className="flex items-center gap-3 min-w-0 flex-1"
                  >
                    <SiteFavicon siteName={site.name} siteUrl={site.url} className="w-10 h-10" />
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate" style={{ color: "#fafafa" }}>
                        {site.name}
                      </p>
                      <a
                        href={site.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-mono flex items-center gap-1 truncate"
                        style={{ color: "#71717a" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {formatHostname(site.url)}
                        <ExternalLink size={10} />
                      </a>
                    </div>
                  </Link>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => startCrawlMutation.mutate(site.id)}
                      disabled={startCrawlMutation.isPending}
                      className="p-2 rounded-md touch-target-sm"
                      style={{ color: "#22c55e" }}
                      aria-label={`Start crawl for ${site.name}`}
                    >
                      <Play size={16} fill="currentColor" />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm("Delete this site?")) {
                          deleteMutation.mutate(site.id);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                      className="p-2 rounded-md touch-target-sm"
                      style={{ color: "#ef4444" }}
                      aria-label={`Delete ${site.name}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-3 border-t" style={{ borderColor: "#27272a" }}>
                  <div className="flex items-center gap-2">
                    {site.lastCrawl ? (
                      <>
                        <StatusIndicator status={site.lastCrawl.status || "unknown"} />
                        <span className="text-xs font-mono" style={{ color: "#71717a" }}>
                          {new Date(site.lastCrawl.createdAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs font-mono" style={{ color: "#52525b" }}>Never crawled</span>
                    )}
                  </div>
                  {site.scheduleEnabled ? (
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono"
                      style={{
                        backgroundColor: "rgba(34, 197, 94, 0.1)",
                        color: "#22c55e",
                      }}
                    >
                      <ClockIcon size={12} />
                      <span className="hidden sm:inline">{site.scheduleCron}</span>
                    </span>
                  ) : (
                    <span className="text-xs font-mono" style={{ color: "#52525b" }}>No schedule</span>
                  )}
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
      className="text-center py-20 px-8 card-dark"
    >
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
      >
        <div
          className="w-16 h-16 mx-auto mb-4 rounded-xl flex items-center justify-center"
          style={{ backgroundColor: "#27272a" }}
        >
          <Globe size={32} style={{ color: "#6366f1" }} />
        </div>
        <h3 className="text-lg font-bold mb-2" style={{ color: "#fafafa" }}>
          No sites yet
        </h3>
        <p className="text-sm mb-6 max-w-md mx-auto" style={{ color: "#71717a" }}>
          Add your first Webflow site to begin archiving
        </p>
        <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
          <Link to="/sites/new" className="btn-primary">
            <Plus size={16} />
            Add Your First Site
          </Link>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

function StatusIndicator({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "#f59e0b",
    running: "#3b82f6",
    completed: "#22c55e",
    failed: "#ef4444",
    cancelled: "#71717a",
  };

  const color = colors[status] || colors.pending;

  return (
    <span
      className="w-2 h-2 rounded-full"
      style={{
        backgroundColor: color,
        boxShadow: status === "running" ? `0 0 8px ${color}` : undefined,
        animation: status === "running" ? "pulse 1.5s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function ClockIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12,6 12,12 16,14" />
    </svg>
  );
}
