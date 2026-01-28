import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sitesApi, crawlsApi } from "@/lib/api";
import { ArrowLeft, Play, ExternalLink, Trash2 } from "lucide-react";

export const Route = createFileRoute("/sites/$siteId")({
  component: SiteDetailPage,
});

function SiteDetailPage() {
  const { siteId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["sites", siteId],
    queryFn: () => sitesApi.get(siteId),
  });

  const startCrawlMutation = useMutation({
    mutationFn: () => sitesApi.startCrawl(siteId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["sites", siteId] });
      queryClient.invalidateQueries({ queryKey: ["crawls"] });
      navigate({ to: "/crawls/$crawlId", params: { crawlId: data.crawl.id } });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => sitesApi.delete(siteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      navigate({ to: "/sites" });
    },
  });

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
        <p className="text-destructive">Failed to load site</p>
      </div>
    );
  }

  const { site } = data;

  return (
    <div className="p-8">
      <div className="mb-8">
        <Link
          to="/sites"
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft size={16} />
          Back to Sites
        </Link>

        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{site.name}</h1>
            <a
              href={site.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-primary flex items-center gap-1 mt-1"
            >
              {site.url}
              <ExternalLink size={14} />
            </a>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => startCrawlMutation.mutate()}
              disabled={startCrawlMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
            >
              <Play size={18} />
              {startCrawlMutation.isPending ? "Starting..." : "Start Crawl"}
            </button>
            <button
              onClick={() => {
                if (confirm("Are you sure you want to delete this site?")) {
                  deleteMutation.mutate();
                }
              }}
              className="p-2 text-muted-foreground hover:text-destructive hover:bg-muted rounded-md"
            >
              <Trash2 size={18} />
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Configuration */}
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-card border border-border rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">Configuration</h2>
            <dl className="space-y-3">
              <div>
                <dt className="text-sm text-muted-foreground">Concurrency</dt>
                <dd className="font-medium">{site.concurrency || 5} pages</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Max Pages</dt>
                <dd className="font-medium">{site.maxPages || "Unlimited"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Remove Badge</dt>
                <dd className="font-medium">{site.removeWebflowBadge ? "Yes" : "No"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Storage</dt>
                <dd className="font-medium capitalize">{site.storageType || "local"}</dd>
              </div>
            </dl>
          </div>

          <div className="bg-card border border-border rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">Schedule</h2>
            {site.scheduleEnabled ? (
              <dl className="space-y-3">
                <div>
                  <dt className="text-sm text-muted-foreground">Cron</dt>
                  <dd className="font-medium font-mono text-sm">{site.scheduleCron}</dd>
                </div>
                {site.nextScheduledAt && (
                  <div>
                    <dt className="text-sm text-muted-foreground">Next Run</dt>
                    <dd className="font-medium">
                      {new Date(site.nextScheduledAt).toLocaleString()}
                    </dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="text-muted-foreground text-sm">Scheduling disabled</p>
            )}
          </div>
        </div>

        {/* Crawl History */}
        <div className="lg:col-span-2">
          <div className="bg-card border border-border rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">Crawl History</h2>

            {site.crawls.length === 0 ? (
              <p className="text-muted-foreground text-sm">No crawls yet</p>
            ) : (
              <div className="space-y-3">
                {site.crawls.map((crawl) => (
                  <Link
                    key={crawl.id}
                    to="/crawls/$crawlId"
                    params={{ crawlId: crawl.id }}
                    className="flex items-center justify-between p-4 border border-border rounded-lg hover:bg-muted/30 transition-colors"
                  >
                    <div>
                      <div className="flex items-center gap-3">
                        <StatusBadge status={crawl.status || "unknown"} />
                        <span className="text-sm text-muted-foreground">
                          {new Date(crawl.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-sm mt-1">
                        {crawl.succeededPages ?? 0} / {crawl.totalPages ?? "?"} pages
                        {crawl.failedPages ? ` (${crawl.failedPages} failed)` : ""}
                      </p>
                    </div>
                    {crawl.status === "completed" && (
                      <div className="flex items-center gap-2">
                        <a
                          href={crawlsApi.getPreviewUrl(crawl.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-primary hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Preview
                        </a>
                        <a
                          href={crawlsApi.getDownloadUrl(crawl.id)}
                          className="text-sm text-primary hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Download
                        </a>
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            )}
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
