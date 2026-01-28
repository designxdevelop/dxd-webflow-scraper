import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { crawlsApi } from "@/lib/api";
import { History } from "lucide-react";

export const Route = createFileRoute("/crawls/")({
  component: CrawlsPage,
});

function CrawlsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["crawls"],
    queryFn: () => crawlsApi.list({ limit: 50 }),
    refetchInterval: 5000, // Refresh every 5 seconds for running crawls
  });

  const crawls = data?.crawls || [];

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">Crawls</h1>
        <p className="text-muted-foreground mt-1">View all crawl jobs and their status</p>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground">Loading...</div>
      ) : crawls.length === 0 ? (
        <div className="text-center py-12 bg-card border border-border rounded-lg">
          <History size={48} className="mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">No crawls yet</h3>
          <p className="text-muted-foreground mb-4">
            Start a crawl from the Sites page to see it here
          </p>
          <Link
            to="/sites"
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
          >
            Go to Sites
          </Link>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Site
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Progress
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Started
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Duration
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {crawls.map((crawl) => {
                const duration = crawl.completedAt && crawl.startedAt
                  ? formatDuration(new Date(crawl.completedAt).getTime() - new Date(crawl.startedAt).getTime())
                  : crawl.startedAt
                    ? formatDuration(Date.now() - new Date(crawl.startedAt).getTime())
                    : "-";

                return (
                  <tr key={crawl.id} className="hover:bg-muted/30">
                    <td className="px-6 py-4">
                      <Link
                        to="/crawls/$crawlId"
                        params={{ crawlId: crawl.id }}
                        className="font-medium text-foreground hover:text-primary"
                      >
                        {crawl.site?.name || "Unknown Site"}
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={crawl.status || "unknown"} />
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary transition-all"
                            style={{
                              width: `${crawl.totalPages ? ((crawl.succeededPages || 0) / crawl.totalPages) * 100 : 0}%`,
                            }}
                          />
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {crawl.succeededPages ?? 0}/{crawl.totalPages ?? "?"}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">
                      {crawl.startedAt
                        ? new Date(crawl.startedAt).toLocaleString()
                        : "Pending"}
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">
                      {duration}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          to="/crawls/$crawlId"
                          params={{ crawlId: crawl.id }}
                          className="text-sm text-primary hover:underline"
                        >
                          View
                        </Link>
                        {crawl.status === "completed" && (
                          <>
                            <a
                              href={crawlsApi.getPreviewUrl(crawl.id)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-primary hover:underline"
                            >
                              Preview
                            </a>
                            <a
                              href={crawlsApi.getDownloadUrl(crawl.id)}
                              className="text-sm text-primary hover:underline"
                            >
                              Download
                            </a>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    running: "bg-blue-100 text-blue-800",
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
