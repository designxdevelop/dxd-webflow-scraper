import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { sitesApi, crawlsApi } from "@/lib/api";
import { Globe, CheckCircle, Clock, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

function DashboardPage() {
  const { data: sitesData } = useQuery({
    queryKey: ["sites"],
    queryFn: sitesApi.list,
  });

  const { data: crawlsData } = useQuery({
    queryKey: ["crawls", { limit: 5 }],
    queryFn: () => crawlsApi.list({ limit: 5 }),
  });

  const sites = sitesData?.sites || [];
  const recentCrawls = crawlsData?.crawls || [];

  const runningCrawls = recentCrawls.filter((c) => c.status === "running").length;
  const completedCrawls = recentCrawls.filter((c) => c.status === "completed").length;

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Overview of your Webflow site archives</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <StatCard
          title="Total Sites"
          value={sites.length}
          icon={<Globe className="text-primary" size={24} />}
        />
        <StatCard
          title="Running Crawls"
          value={runningCrawls}
          icon={<Clock className="text-yellow-500" size={24} />}
        />
        <StatCard
          title="Completed Today"
          value={completedCrawls}
          icon={<CheckCircle className="text-green-500" size={24} />}
        />
      </div>

      {/* Recent activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Sites */}
        <div className="bg-card border border-border rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Sites</h2>
            <Link
              to="/sites"
              className="text-sm text-primary hover:underline flex items-center gap-1"
            >
              View all <ArrowRight size={14} />
            </Link>
          </div>

          {sites.length === 0 ? (
            <p className="text-muted-foreground text-sm">No sites configured yet.</p>
          ) : (
            <ul className="space-y-3">
              {sites.slice(0, 5).map((site) => (
                <li key={site.id} className="flex items-center justify-between">
                  <div>
                    <Link
                      to="/sites/$siteId"
                      params={{ siteId: site.id }}
                      className="font-medium hover:text-primary"
                    >
                      {site.name}
                    </Link>
                    <p className="text-sm text-muted-foreground truncate max-w-[200px]">
                      {site.url}
                    </p>
                  </div>
                  {site.lastCrawl && (
                    <StatusBadge status={site.lastCrawl.status || "unknown"} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Recent Crawls */}
        <div className="bg-card border border-border rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Recent Crawls</h2>
            <Link
              to="/crawls"
              className="text-sm text-primary hover:underline flex items-center gap-1"
            >
              View all <ArrowRight size={14} />
            </Link>
          </div>

          {recentCrawls.length === 0 ? (
            <p className="text-muted-foreground text-sm">No crawls yet.</p>
          ) : (
            <ul className="space-y-3">
              {recentCrawls.map((crawl) => (
                <li key={crawl.id} className="flex items-center justify-between">
                  <div>
                    <Link
                      to="/crawls/$crawlId"
                      params={{ crawlId: crawl.id }}
                      className="font-medium hover:text-primary"
                    >
                      {crawl.site?.name || "Unknown Site"}
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      {crawl.succeededPages ?? 0}/{crawl.totalPages ?? "?"} pages
                    </p>
                  </div>
                  <StatusBadge status={crawl.status || "unknown"} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  icon,
}: {
  title: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="text-3xl font-bold mt-1">{value}</p>
        </div>
        {icon}
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
