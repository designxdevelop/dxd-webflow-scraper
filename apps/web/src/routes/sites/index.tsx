import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sitesApi } from "@/lib/api";
import { Plus, Globe, Trash2, Play, ExternalLink } from "lucide-react";


export const Route = createFileRoute("/sites/")({
  component: SitesPage,
});

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

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Sites</h1>
          <p className="text-muted-foreground mt-1">Manage your Webflow sites to archive</p>
        </div>
        <Link
          to="/sites/new"
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          <Plus size={18} />
          Add Site
        </Link>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground">Loading...</div>
      ) : sites.length === 0 ? (
        <div className="text-center py-12 bg-card border border-border rounded-lg">
          <Globe size={48} className="mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">No sites yet</h3>
          <p className="text-muted-foreground mb-4">Add your first Webflow site to start archiving</p>
          <Link
            to="/sites/new"
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
          >
            <Plus size={18} />
            Add Site
          </Link>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  URL
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Last Crawl
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Schedule
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sites.map((site) => (
                <tr key={site.id} className="hover:bg-muted/30">
                  <td className="px-6 py-4">
                    <Link
                      to="/sites/$siteId"
                      params={{ siteId: site.id }}
                      className="font-medium text-foreground hover:text-primary"
                    >
                      {site.name}
                    </Link>
                  </td>
                  <td className="px-6 py-4">
                    <a
                      href={site.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1"
                    >
                      {new URL(site.url).hostname}
                      <ExternalLink size={12} />
                    </a>
                  </td>
                  <td className="px-6 py-4">
                    {site.lastCrawl ? (
                      <div>
                        <StatusBadge status={site.lastCrawl.status || "unknown"} />
                        <p className="text-xs text-muted-foreground mt-1">
                          {new Date(site.lastCrawl.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">Never</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {site.scheduleEnabled ? (
                      <span className="text-sm text-green-600">{site.scheduleCron}</span>
                    ) : (
                      <span className="text-sm text-muted-foreground">Disabled</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => startCrawlMutation.mutate(site.id)}
                        disabled={startCrawlMutation.isPending}
                        className="p-2 text-muted-foreground hover:text-primary hover:bg-muted rounded-md"
                        title="Start Crawl"
                      >
                        <Play size={16} />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm("Are you sure you want to delete this site?")) {
                            deleteMutation.mutate(site.id);
                          }
                        }}
                        disabled={deleteMutation.isPending}
                        className="p-2 text-muted-foreground hover:text-destructive hover:bg-muted rounded-md"
                        title="Delete"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
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
