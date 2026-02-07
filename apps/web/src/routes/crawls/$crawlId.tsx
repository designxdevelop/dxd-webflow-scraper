import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
      <div className="p-8">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8">
        <p className="text-destructive">Failed to load crawl</p>
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
    <div className="p-8">
      <div className="mb-8">
        <Link
          to="/crawls"
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft size={16} />
          Back to Crawls
        </Link>

        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">
                {crawl.site?.name || "Unknown Site"}
              </h1>
              <StatusBadge status={crawl.status || "unknown"} />
              {isActive && (
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  {connected ? (
                    <>
                      <Wifi size={14} className="text-green-500" />
                      Live
                    </>
                  ) : (
                    <>
                      <WifiOff size={14} className="text-yellow-500" />
                      Connecting...
                    </>
                  )}
                </span>
              )}
            </div>
            <p className="text-muted-foreground mt-1">
              Started {crawl.startedAt ? new Date(crawl.startedAt).toLocaleString() : "pending"}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {(crawl.status === "running" || crawl.status === "pending") && (
              <button
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
                className="flex items-center gap-2 px-4 py-2 border border-destructive text-destructive rounded-md hover:bg-destructive/10"
              >
                <XCircle size={18} />
                Cancel
              </button>
            )}
            {crawl.status === "uploading" && (
              <span className="px-4 py-2 text-sm text-muted-foreground border border-border rounded-md">
                Uploading{uploadProgress ? ` ${Math.round(uploadProgress.percent)}%` : "..."}
              </span>
            )}
            {crawl.status === "completed" && crawl.outputPath && (
              <>
                <a
                  href={crawlsApi.getPreviewUrl(crawl.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-4 py-2 border border-border rounded-md hover:bg-muted"
                >
                  <ExternalLink size={18} />
                  Preview
                </a>
                <a
                  href={crawlsApi.getDownloadUrl(crawl.id)}
                  className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  <Download size={18} />
                  Download
                </a>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Stats */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-card border border-border rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">Progress</h2>

            <div className="mb-4">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-muted-foreground">Pages</span>
                <span>
                  {displayProgress.succeeded} / {displayProgress.total || "?"}
                </span>
              </div>
              <div className="w-full h-3 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{
                    width: `${displayProgress.total ? (displayProgress.succeeded / displayProgress.total) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>

            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Succeeded</dt>
                <dd className="text-green-600 font-medium">{displayProgress.succeeded}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Failed</dt>
                <dd className="text-red-600 font-medium">{displayProgress.failed}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Total</dt>
                <dd className="font-medium">{displayProgress.total || "?"}</dd>
              </div>
            </dl>
          </div>

          {crawl.status === "uploading" && uploadProgress && (
            <div className="bg-card border border-border rounded-lg p-6">
              <h2 className="text-lg font-semibold mb-4">Upload</h2>
              <div className="mb-4">
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">Storage</span>
                  <span>{Math.round(uploadProgress.percent)}%</span>
                </div>
                <div className="w-full h-3 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 transition-all duration-300"
                    style={{ width: `${uploadProgress.percent}%` }}
                  />
                </div>
              </div>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Bytes</dt>
                  <dd className="font-medium">
                    {formatBytes(uploadProgress.uploadedBytes)} / {formatBytes(uploadProgress.totalBytes)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Files</dt>
                  <dd className="font-medium">
                    {uploadProgress.filesUploaded} / {uploadProgress.filesTotal || "?"}
                  </dd>
                </div>
              </dl>
              {uploadProgress.currentFile && (
                <p className="text-xs text-muted-foreground mt-3 truncate">
                  Current: {uploadProgress.currentFile}
                </p>
              )}
            </div>
          )}

          {crawl.errorMessage && (
            <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4">
              <h3 className="text-sm font-medium text-destructive mb-2">Error</h3>
              <p className="text-sm text-destructive/80">{crawl.errorMessage}</p>
            </div>
          )}

          {progress?.currentUrl && (
            <div className="bg-card border border-border rounded-lg p-4">
              <h3 className="text-sm font-medium mb-2">Current URL</h3>
              <p className="text-sm text-muted-foreground truncate">{progress.currentUrl}</p>
            </div>
          )}

          {suggestionQuery.data?.suggestions && suggestionQuery.data.suggestions.length > 0 && (
            <div className="bg-card border border-border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Download Blacklist Suggestions</h3>
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
                  className="text-xs px-2 py-1 border border-border rounded-md hover:bg-muted disabled:opacity-50"
                >
                  Blacklist All
                </button>
              </div>

              <p className="text-xs text-muted-foreground">
                Repeated failed downloads were detected. Add them to this site&apos;s blacklist so
                future crawls skip them.
              </p>

              <div className="space-y-2">
                {suggestionQuery.data.suggestions.map((suggestion) => (
                  <div key={suggestion.url} className="border border-border rounded-md p-2">
                    <div className="text-xs text-muted-foreground mb-1">
                      {suggestion.count} failed attempts
                    </div>
                    <p className="text-xs break-all mb-2">{suggestion.url}</p>
                    {suggestion.alreadyBlacklisted ? (
                      <span className="text-xs text-green-700">Already blacklisted</span>
                    ) : (
                      <button
                        type="button"
                        disabled={applySuggestionsMutation.isPending}
                        onClick={() => applySuggestionsMutation.mutate([suggestion.url])}
                        className="text-xs inline-flex items-center gap-1 px-2 py-1 border border-border rounded-md hover:bg-muted disabled:opacity-50"
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
          <div className="bg-card border border-border rounded-lg">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-lg font-semibold">Logs</h2>
            </div>

            <div className="h-[600px] overflow-auto p-4 font-mono text-sm bg-slate-950 text-slate-200">
              {allLogs.length === 0 ? (
                <p className="text-slate-500">No logs yet...</p>
              ) : (
                  allLogs.map((log, i) => (
                  <div key={i} className="py-1 flex gap-2">
                    <LogLevelBadge level={log.level} />
                    <span className="text-slate-400 shrink-0">
                      {new Date(getLogTimestamp(log)).toLocaleTimeString()}
                    </span>
                    <span className="break-all">{log.message}</span>
                    {log.url && (
                      <span className="text-slate-500 truncate shrink-0 max-w-[200px]">
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
  const styles: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    running: "bg-blue-100 text-blue-800",
    uploading: "bg-indigo-100 text-indigo-800",
    completed: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
    cancelled: "bg-gray-100 text-gray-800",
  };

  return (
    <span
      className={`px-2 py-1 rounded-full text-xs font-medium ${styles[status] || styles.pending}`}
    >
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
  const styles: Record<string, string> = {
    debug: "text-slate-500",
    info: "text-blue-400",
    warn: "text-yellow-400",
    error: "text-red-400",
  };

  return (
    <span className={`shrink-0 w-12 ${styles[level] || styles.info}`}>
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
