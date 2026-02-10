import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { crawlsApi } from "@/lib/api";
import { formatToMountainDate } from "@/lib/date";
import { History, ArrowRight, Download, Eye, Clock } from "lucide-react";

export const Route = createFileRoute("/crawls/")({
  component: CrawlsPage,
});

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.02,
      delayChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 5 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.2,
      ease: "easeOut" as const,
    },
  },
};

function CrawlsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["crawls"],
    queryFn: () => crawlsApi.list({ limit: 50 }),
    refetchInterval: 5000,
  });

  const crawls = data?.crawls || [];

  const runningCount = crawls.filter((c) => c.status === "running").length;
  const uploadingCount = crawls.filter((c) => c.status === "uploading").length;
  const completedCount = crawls.filter((c) => c.status === "completed").length;
  const failedCount = crawls.filter((c) => c.status === "failed").length;

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
              crawls/history
            </span>
            <h1 className="text-xl md:text-2xl font-bold mt-1 mb-1" style={{ color: "#fafafa" }}>
              Crawls
            </h1>
            <p className="text-sm" style={{ color: "#71717a" }}>
              View crawl operations and archives
            </p>
          </div>

          <Link
            to="/sites"
            className="btn-secondary touch-target-sm shrink-0"
            aria-label="Start new crawl"
          >
            <span className="hidden sm:inline">Start New Crawl</span>
            <span className="sm:hidden">New Crawl</span>
            <ArrowRight size={16} />
          </Link>
        </div>

        {/* Stats */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.3 }}
          className="flex flex-wrap gap-4 mt-4"
        >
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#3b82f6", boxShadow: "0 0 6px #3b82f6" }} />
            <span className="text-sm font-mono" style={{ color: "#71717a" }}>
              <span style={{ color: "#fafafa" }}>{runningCount}</span> running
            </span>
          </div>
          {uploadingCount > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#8b5cf6", boxShadow: "0 0 6px #8b5cf6" }} />
              <span className="text-sm font-mono" style={{ color: "#71717a" }}>
                <span style={{ color: "#fafafa" }}>{uploadingCount}</span> uploading
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#22c55e" }} />
            <span className="text-sm font-mono" style={{ color: "#71717a" }}>
              <span style={{ color: "#fafafa" }}>{completedCount}</span> completed
            </span>
          </div>
          {failedCount > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#ef4444" }} />
              <span className="text-sm font-mono" style={{ color: "#71717a" }}>
                <span style={{ color: "#fafafa" }}>{failedCount}</span> failed
              </span>
            </div>
          )}
        </motion.div>
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
      ) : crawls.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* Desktop: Table View */}
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
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {crawls.map((crawl) => {
                  const duration = crawl.completedAt && crawl.startedAt
                    ? formatDuration(new Date(crawl.completedAt).getTime() - new Date(crawl.startedAt).getTime())
                    : crawl.startedAt
                      ? formatDuration(Date.now() - new Date(crawl.startedAt).getTime())
                      : "-";

                  const isUploading = crawl.status === "uploading";
                  const uploadPercent = isUploading && crawl.uploadTotalBytes
                    ? Math.round(((crawl.uploadUploadedBytes || 0) / crawl.uploadTotalBytes) * 100)
                    : 0;
                  const crawlProgress = crawl.totalPages
                    ? Math.round(((crawl.succeededPages || 0) / crawl.totalPages) * 100)
                    : 0;
                  const progress = isUploading ? uploadPercent : crawlProgress;

                  return (
                    <motion.tr
                      key={crawl.id}
                      variants={itemVariants}
                      className="group"
                    >
                      <td>
                        <Link
                          to="/crawls/$crawlId"
                          params={{ crawlId: crawl.id }}
                          className="flex flex-col"
                        >
                          <span className="font-medium text-sm group-hover:underline" style={{ color: "#fafafa" }}>
                            {crawl.site?.name || "Unknown"}
                          </span>
                          <span className="text-xs font-mono" style={{ color: "#52525b" }}>
                            #{crawl.id.slice(0, 8)}
                          </span>
                        </Link>
                      </td>
                      <td>
                        <StatusBadge status={crawl.status || "unknown"} />
                      </td>
                      <td>
                        <div className="flex items-center gap-3">
                          <div className="w-20 progress-dark">
                            <div
                              className="progress-dark-fill"
                              style={{
                                width: `${progress}%`,
                                background: crawl.status === "failed"
                                  ? "linear-gradient(90deg, #ef4444 0%, #f87171 100%)"
                                  : crawl.status === "completed"
                                    ? "linear-gradient(90deg, #22c55e 0%, #4ade80 100%)"
                                    : isUploading
                                      ? "linear-gradient(90deg, #8b5cf6 0%, #a78bfa 100%)"
                                      : undefined,
                              }}
                            />
                          </div>
                          <span className="text-xs font-mono" style={{ color: "#71717a" }}>
                            {isUploading
                              ? `${progress}%`
                              : `${crawl.succeededPages ?? 0}/${crawl.totalPages ?? "?"}`
                            }
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center gap-2 text-sm font-mono" style={{ color: "#71717a" }}>
                          <Clock size={14} />
                          {crawl.startedAt ? (
                            <span>
                              {formatToMountainDate(crawl.startedAt)}
                            </span>
                          ) : (
                            "pending"
                          )}
                        </div>
                      </td>
                      <td>
                        <span className="text-sm font-mono" style={{ color: "#71717a" }}>
                          {duration}
                        </span>
                      </td>
                      <td>
                        <div className="flex items-center justify-end gap-2">
                          <Link
                            to="/crawls/$crawlId"
                            params={{ crawlId: crawl.id }}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors touch-target-sm"
                            style={{
                              backgroundColor: "#27272a",
                              color: "#a1a1aa",
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
                            <Eye size={14} />
                            View
                          </Link>
                          {crawl.status === "completed" &&
                            crawl.outputPath?.endsWith(".zip") &&
                            (crawl.outputSizeBytes ?? 0) > 0 && (
                            <a
                              href={crawlsApi.getDownloadUrl(crawl.id)}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors touch-target-sm"
                              style={{
                                backgroundColor: "rgba(99, 102, 241, 0.1)",
                                color: "#818cf8",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = "rgba(99, 102, 241, 0.2)";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = "rgba(99, 102, 241, 0.1)";
                              }}
                            >
                              <Download size={14} />
                              Download
                            </a>
                          )}
                        </div>
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </motion.div>

          {/* Mobile: Card View */}
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="md:hidden space-y-3"
          >
            {crawls.map((crawl) => {
              const duration = crawl.completedAt && crawl.startedAt
                ? formatDuration(new Date(crawl.completedAt).getTime() - new Date(crawl.startedAt).getTime())
                : crawl.startedAt
                  ? formatDuration(Date.now() - new Date(crawl.startedAt).getTime())
                  : "-";

              const isUploading = crawl.status === "uploading";
              const uploadPercent = isUploading && crawl.uploadTotalBytes
                ? Math.round(((crawl.uploadUploadedBytes || 0) / crawl.uploadTotalBytes) * 100)
                : 0;
              const crawlProgress = crawl.totalPages
                ? Math.round(((crawl.succeededPages || 0) / crawl.totalPages) * 100)
                : 0;
              const progress = isUploading ? uploadPercent : crawlProgress;

              return (
                <motion.div
                  key={crawl.id}
                  variants={itemVariants}
                  className="card-dark p-4"
                >
                  <div className="flex items-start justify-between mb-3">
                    <Link
                      to="/crawls/$crawlId"
                      params={{ crawlId: crawl.id }}
                      className="min-w-0 flex-1"
                    >
                      <p className="font-medium text-sm truncate" style={{ color: "#fafafa" }}>
                        {crawl.site?.name || "Unknown"}
                      </p>
                      <p className="text-xs font-mono" style={{ color: "#52525b" }}>
                        #{crawl.id.slice(0, 8)}
                      </p>
                    </Link>
                    <StatusBadge status={crawl.status || "unknown"} />
                  </div>
                  
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex-1 progress-dark">
                      <div
                        className="progress-dark-fill"
                        style={{
                          width: `${progress}%`,
                          background: crawl.status === "failed"
                            ? "linear-gradient(90deg, #ef4444 0%, #f87171 100%)"
                            : crawl.status === "completed"
                              ? "linear-gradient(90deg, #22c55e 0%, #4ade80 100%)"
                              : isUploading
                                ? "linear-gradient(90deg, #8b5cf6 0%, #a78bfa 100%)"
                                : undefined,
                        }}
                      />
                    </div>
                    <span className="text-xs font-mono shrink-0" style={{ color: "#71717a" }}>
                      {isUploading
                        ? `${progress}%`
                        : `${crawl.succeededPages ?? 0}/${crawl.totalPages ?? "?"}`
                      }
                    </span>
                  </div>
                  
                  <div className="flex items-center justify-between text-xs font-mono mb-3" style={{ color: "#71717a" }}>
                    <div className="flex items-center gap-2">
                      <Clock size={12} />
                      {crawl.startedAt ? (
                        <span>
                          {formatToMountainDate(crawl.startedAt)}
                        </span>
                      ) : (
                        "pending"
                      )}
                    </div>
                    <span>{duration}</span>
                  </div>
                  
                  <div className="flex items-center justify-end gap-2 pt-3 border-t" style={{ borderColor: "#27272a" }}>
                    <Link
                      to="/crawls/$crawlId"
                      params={{ crawlId: crawl.id }}
                      className="flex items-center gap-1.5 px-3 py-2 rounded text-xs font-medium touch-target-sm"
                      style={{
                        backgroundColor: "#27272a",
                        color: "#a1a1aa",
                      }}
                    >
                      <Eye size={14} />
                      View
                    </Link>
                    {crawl.status === "completed" &&
                      crawl.outputPath?.endsWith(".zip") &&
                      (crawl.outputSizeBytes ?? 0) > 0 && (
                      <a
                        href={crawlsApi.getDownloadUrl(crawl.id)}
                        className="flex items-center gap-1.5 px-3 py-2 rounded text-xs font-medium touch-target-sm"
                        style={{
                          backgroundColor: "rgba(99, 102, 241, 0.1)",
                          color: "#818cf8",
                        }}
                      >
                        <Download size={14} />
                        Download
                      </a>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        </>
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
          <History size={32} style={{ color: "#6366f1" }} />
        </div>
        <h3 className="text-lg font-bold mb-2" style={{ color: "#fafafa" }}>
          No crawls yet
        </h3>
        <p className="text-sm mb-6 max-w-md mx-auto" style={{ color: "#71717a" }}>
          Start a crawl from the Sites page
        </p>
        <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
          <Link
            to="/sites"
            className="btn-primary"
            style={{
              backgroundColor: "#6366f1",
            }}
          >
            <ArrowRight size={16} />
            Go to Sites
          </Link>
        </motion.div>
      </motion.div>
    </motion.div>
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
    uploading: {
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

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
