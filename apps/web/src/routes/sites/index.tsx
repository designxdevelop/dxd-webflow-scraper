import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { sitesApi } from "@/lib/api";
import { Plus, Globe, Trash2, Play, ExternalLink, Search } from "lucide-react";

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

  const { data, isLoading } = useQuery({
    queryKey: ["sites"],
    queryFn: sitesApi.list,
  });

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
    <div className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mb-8"
      >
        <div className="flex items-start justify-between">
          <div>
            <span className="text-xs font-mono" style={{ color: "#6366f1" }}>
              sites/manage
            </span>
            <h1 className="text-2xl font-bold mt-1 mb-1" style={{ color: "#fafafa" }}>
              Sites
            </h1>
            <p className="text-sm" style={{ color: "#71717a" }}>
              Manage and configure Webflow sites to archive
            </p>
          </div>

          <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
            <Link to="/sites/new" className="btn-primary">
              <Plus size={16} />
              Add Site
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
      ) : sites.length === 0 ? (
        <EmptyState />
      ) : (
        <div>
          {/* Filters */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-4 mb-6"
          >
            <div className="flex-1 relative max-w-sm">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "#71717a" }} />
              <input
                type="text"
                placeholder="Search sites..."
                className="input-dark pl-10"
              />
            </div>
          </motion.div>

          {/* Sites Table */}
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="card-dark overflow-hidden"
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
                        <div
                          className="w-8 h-8 rounded-md flex items-center justify-center text-sm font-bold font-mono"
                          style={{
                            backgroundColor: "#27272a",
                            color: "#818cf8",
                          }}
                        >
                          {site.name.charAt(0).toUpperCase()}
                        </div>
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
                            {new Date(site.lastCrawl.createdAt).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })}
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
                          className="p-2 rounded-md transition-colors"
                          style={{ color: "#22c55e" }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(34, 197, 94, 0.1)")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                          title="Start Crawl"
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
                          className="p-2 rounded-md transition-colors"
                          style={{ color: "#ef4444" }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(239, 68, 68, 0.1)")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                          title="Delete"
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
