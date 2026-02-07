import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { crawlsApi } from "@/lib/api";
import { useCrawlLogs } from "@/lib/hooks/useCrawlLogs";
import { ArrowLeft, Download, ExternalLink, XCircle, Wifi, WifiOff, Ban } from "lucide-react";
import { useEffect, useRef } from "react";

export const Route = createFileRoute("/crawls/$crawlId")({
  component: CrawlDetailPage,
});

function CrawlDetailPage() {
  const { crawlId } = Route.useParams();
  const queryClient = useQueryClient();
  const logsEndRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["crawls", crawlId],
    queryFn: () => crawlsApi.get(crawlId),
    refetchInterval: (query) => {
      // Stop polling once crawl is complete
      const status = query.state.data?.crawl?.status;
      return status === "running" || status === "pending" || status === "uploading"
        ? 2000
        : false;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => crawlsApi.cancel(crawlId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crawls", crawlId] });
    },
  });

  const suggestionQuery = useQuery({
    queryKey: ["crawls", crawlId, "download-suggestions"],
    queryFn: () => crawlsApi.getDownloadSuggestions(crawlId, { minCount: 3, limit: 8 }),
    enabled:
      data?.crawl?.status === "completed" ||
      data?.crawl?.status === "failed" ||
      data?.crawl?.status === "cancelled",
  });

  const applySuggestionsMutation = useMutation({
    mutationFn: (urls: string[]) => crawlsApi.applyDownloadSuggestions(crawlId, urls),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crawls", crawlId, "download-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["crawls", crawlId] });
      if (data?.crawl?.siteId) {
        queryClient.invalidateQueries({ queryKey: ["sites", data.crawl.siteId] });
      }
      queryClient.invalidateQueries({ queryKey: ["sites"] });
    },
  });

  // Connect to SSE for live logs if crawl is active
  const isActive = data?.crawl?.status === "running" || data?.crawl?.status === "uploading";
  const { logs: liveLogs, progress, connected } = useCrawlLogs(isActive ? crawlId : null);

  // Auto-scroll to bottom of logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [liveLogs]);

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center py-20">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
          className="w-8 h-8 border-2 rounded-full"
          style={{ borderColor: "#27272a", borderTopColor: "#6366f1" }}
        />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8">
        <p className="text-sm font-mono" style={{ color: "#ef4444" }}>Failed to load crawl</p>
      </div>
    );
  }

  const { crawl } = data;
  const displayProgress = progress || {
    total: crawl.totalPages || 0,
    succeeded: crawl.succeededPages || 0,
    failed: crawl.failedPages || 0,
  };
  const uploadProgress = crawl.status === "uploading" ? progress?.upload : undefined;

  const allLogs = dedupeLogs([...(crawl.logs || []).reverse(), ...liveLogs]);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <Link
          to="/crawls"
          className="btn-ghost btn-sm mb-4"
        >
          <ArrowLeft size={14} />
          Back to Crawls
        </Link>

        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <span className="text-xs font-mono" style={{ color: "#6366f1" }}>
                crawls/{crawl.id.slice(0, 8)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold" style={{ color: "#fafafa" }}>
                {crawl.site?.name || "Unknown Site"}
              </h1>
              <StatusBadge status={crawl.status || "unknown"} />
              {isActive && (
                <span className="flex items-center gap-1.5 text-xs font-mono">
                  {connected ? (
                    <>
                      <Wifi size={14} style={{ color: "#22c55e" }} />
                      <span style={{ color: "#22c55e" }}>Live</span>
                    </>
                  ) : (
                    <>
                      <WifiOff size={14} style={{ color: "#f59e0b" }} />
                      <span style={{ color: "#f59e0b" }}>Connecting...</span>
                    </>
                  )}
                </span>
              )}
            </div>
            <p className="text-sm font-mono mt-1" style={{ color: "#71717a" }}>
              Started {crawl.startedAt ? new Date(crawl.startedAt).toLocaleString() : "pending"}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {(crawl.status === "running" || crawl.status === "pending") && (
              <button
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
                className="btn-danger disabled:opacity-50"
              >
                <XCircle size={16} />
                Cancel
              </button>
            )}
            {crawl.status === "uploading" && (
              <span className="btn-secondary" style={{ cursor: "default", opacity: 0.8 }}>
                Uploading{uploadProgress ? ` ${Math.round(uploadProgress.percent)}%` : "..."}
              </span>
            )}
            {crawl.status === "completed" && crawl.outputPath && (
              <>
                <a
                  href={crawlsApi.getPreviewUrl(crawl.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary"
                >
                  <ExternalLink size={16} />
                  Preview
                </a>
                <a
                  href={crawlsApi.getDownloadUrl(crawl.id)}
                  className="btn-primary"
                >
                  <Download size={16} />
                  Download
                </a>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Stats */}
        <div className="lg:col-span-1 space-y-4">
          <div className="card-dark p-6">
            <h2 className="text-sm font-semibold mb-4" style={{ color: "#fafafa" }}>Progress</h2>

            <div className="mb-4">
              <div className="flex justify-between text-xs font-mono mb-1.5">
                <span style={{ color: "#71717a" }}>Pages</span>
                <span style={{ color: "#a1a1aa" }}>
                  {displayProgress.succeeded} / {displayProgress.total || "?"}
                </span>
              </div>
              <div className="progress-dark" style={{ height: "8px" }}>
                <div
                  className="progress-dark-fill"
                  style={{
                    width: `${displayProgress.total ? (displayProgress.succeeded / displayProgress.total) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>

            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-xs" style={{ color: "#71717a" }}>Succeeded</dt>
                <dd className="font-mono font-medium" style={{ color: "#4ade80" }}>{displayProgress.succeeded}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-xs" style={{ color: "#71717a" }}>Failed</dt>
                <dd className="font-mono font-medium" style={{ color: "#f87171" }}>{displayProgress.failed}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-xs" style={{ color: "#71717a" }}>Total</dt>
                <dd className="font-mono font-medium" style={{ color: "#fafafa" }}>{displayProgress.total || "?"}</dd>
              </div>
            </dl>
          </div>

          {crawl.status === "uploading" && uploadProgress && (
            <div className="card-dark p-6">
              <h2 className="text-sm font-semibold mb-4" style={{ color: "#fafafa" }}>Upload</h2>
              <div className="mb-4">
                <div className="flex justify-between text-xs font-mono mb-1.5">
                  <span style={{ color: "#71717a" }}>Storage</span>
                  <span style={{ color: "#a1a1aa" }}>{Math.round(uploadProgress.percent)}%</span>
                </div>
                <div className="progress-dark" style={{ height: "8px" }}>
                  <div
                    className="progress-dark-fill"
                    style={{ width: `${uploadProgress.percent}%` }}
                  />
                </div>
              </div>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-xs" style={{ color: "#71717a" }}>Bytes</dt>
                  <dd className="font-mono font-medium" style={{ color: "#a1a1aa" }}>
                    {formatBytes(uploadProgress.uploadedBytes)} / {formatBytes(uploadProgress.totalBytes)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-xs" style={{ color: "#71717a" }}>Files</dt>
                  <dd className="font-mono font-medium" style={{ color: "#a1a1aa" }}>
                    {uploadProgress.filesUploaded} / {uploadProgress.filesTotal || "?"}
                  </dd>
                </div>
              </dl>
              {uploadProgress.currentFile && (
                <p className="text-xs font-mono mt-3 truncate" style={{ color: "#52525b" }}>
                  Current: {uploadProgress.currentFile}
                </p>
              )}
            </div>
          )}

          {crawl.errorMessage && (
            <div
              className="rounded-lg p-4"
              style={{ backgroundColor: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)" }}
            >
              <h3 className="text-xs font-semibold mb-2" style={{ color: "#f87171" }}>Error</h3>
              <p className="text-sm" style={{ color: "#fca5a5" }}>{crawl.errorMessage}</p>
            </div>
          )}

          {progress?.currentUrl && (
            <div className="card-dark p-4">
              <h3 className="text-xs font-semibold mb-2" style={{ color: "#a1a1aa" }}>Current URL</h3>
              <p className="text-xs font-mono truncate" style={{ color: "#71717a" }}>{progress.currentUrl}</p>
            </div>
          )}

          {suggestionQuery.data?.suggestions && suggestionQuery.data.suggestions.length > 0 && (
            <div className="card-dark p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold" style={{ color: "#fafafa" }}>Blacklist Suggestions</h3>
                <button
                  type="button"
                  disabled={applySuggestionsMutation.isPending}
                  onClick={() => {
                    const urls = suggestionQuery.data!.suggestions
                      .filter((suggestion) => !suggestion.alreadyBlacklisted)
                      .map((suggestion) => suggestion.url);
                    if (urls.length > 0) {
                      applySuggestionsMutation.mutate(urls);
                    }
                  }}
                  className="btn-ghost btn-sm disabled:opacity-50"
                >
                  Blacklist All
                </button>
              </div>

              <p className="text-xs" style={{ color: "#71717a" }}>
                Repeated failed downloads were detected. Add them to this site&apos;s blacklist so
                future crawls skip them.
              </p>

              <div className="space-y-2">
                {suggestionQuery.data.suggestions.map((suggestion) => (
                  <div
                    key={suggestion.url}
                    className="rounded-lg p-3"
                    style={{ backgroundColor: "#09090b", border: "1px solid #27272a" }}
                  >
                    <div className="text-xs font-mono mb-1" style={{ color: "#71717a" }}>
                      {suggestion.count} failed attempts
                    </div>
                    <p className="text-xs font-mono break-all mb-2" style={{ color: "#a1a1aa" }}>{suggestion.url}</p>
                    {suggestion.alreadyBlacklisted ? (
                      <span className="text-xs font-mono" style={{ color: "#4ade80" }}>Already blacklisted</span>
                    ) : (
                      <button
                        type="button"
                        disabled={applySuggestionsMutation.isPending}
                        onClick={() => applySuggestionsMutation.mutate([suggestion.url])}
                        className="btn-ghost btn-sm disabled:opacity-50"
                      >
                        <Ban size={12} />
                        Blacklist URL
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Logs */}
        <div className="lg:col-span-3">
          <div className="card-dark overflow-hidden">
            <div className="px-6 py-4" style={{ borderBottom: "1px solid #27272a" }}>
              <h2 className="text-sm font-semibold" style={{ color: "#fafafa" }}>Logs</h2>
            </div>

            <div className="h-[600px] overflow-auto p-4 font-mono text-sm" style={{ backgroundColor: "#09090b", color: "#e2e8f0" }}>
              {allLogs.length === 0 ? (
                <p style={{ color: "#52525b" }}>No logs yet...</p>
              ) : (
                  allLogs.map((log, i) => (
                  <div key={i} className="py-1 flex gap-2">
                    <LogLevelBadge level={log.level} />
                    <span className="shrink-0" style={{ color: "#71717a" }}>
                      {new Date(getLogTimestamp(log)).toLocaleTimeString()}
                    </span>
                    <span className="break-all" style={{ color: "#e2e8f0" }}>{log.message}</span>
                    {log.url && (
                      <span className="truncate shrink-0 max-w-[200px]" style={{ color: "#52525b" }}>
                        {log.url}
                      </span>
                    )}
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; color: string }> = {
    pending: { bg: "rgba(245, 158, 11, 0.15)", color: "#fbbf24" },
    running: { bg: "rgba(59, 130, 246, 0.15)", color: "#60a5fa" },
    uploading: { bg: "rgba(99, 102, 241, 0.15)", color: "#818cf8" },
    completed: { bg: "rgba(34, 197, 94, 0.15)", color: "#4ade80" },
    failed: { bg: "rgba(239, 68, 68, 0.15)", color: "#f87171" },
    cancelled: { bg: "rgba(113, 113, 122, 0.15)", color: "#a1a1aa" },
  };

  const style = styles[status] || styles.pending;

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono"
      style={{ backgroundColor: style.bg, color: style.color }}
    >
      <span
        className={`w-1 h-1 rounded-full ${status === "running" || status === "uploading" ? "animate-pulse" : ""}`}
        style={{
          backgroundColor: style.color,
          boxShadow: status === "running" || status === "uploading" ? `0 0 6px ${style.color}` : undefined,
        }}
      />
      {status}
    </span>
  );
}

type CrawlLogLike = { level: string; message: string; url?: string | null; timestamp?: string; createdAt?: string };

function getLogTimestamp(log: CrawlLogLike): string {
  return "createdAt" in log && log.createdAt ? log.createdAt : log.timestamp || new Date().toISOString();
}

function dedupeLogs(logs: CrawlLogLike[]) {
  const seen = new Set<string>();
  return logs.filter((log) => {
    const timestamp = getLogTimestamp(log);
    const key = `${log.level}|${log.message}|${log.url || ""}|${timestamp}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function LogLevelBadge({ level }: { level: string }) {
  const colors: Record<string, string> = {
    debug: "#52525b",
    info: "#60a5fa",
    warn: "#fbbf24",
    error: "#f87171",
  };

  return (
    <span className="shrink-0 w-12" style={{ color: colors[level] || colors.info }}>
      [{level}]
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${value.toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}
