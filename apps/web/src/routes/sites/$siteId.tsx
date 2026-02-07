import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sitesApi, crawlsApi } from "@/lib/api";
import { ArrowLeft, Play, ExternalLink, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

type ScheduleFrequency = "daily" | "weekly";

const WEEKDAYS = [
  { label: "Sun", value: "0" },
  { label: "Mon", value: "1" },
  { label: "Tue", value: "2" },
  { label: "Wed", value: "3" },
  { label: "Thu", value: "4" },
  { label: "Fri", value: "5" },
  { label: "Sat", value: "6" },
];

function toCronExpression(frequency: ScheduleFrequency, time: string, days: string[]): string | null {
  const [hourString, minuteString] = time.split(":");
  const hour = Number.parseInt(hourString, 10);
  const minute = Number.parseInt(minuteString, 10);

  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  if (frequency === "daily") {
    return `${minute} ${hour} * * *`;
  }

  const dayList = days.length > 0 ? days.join(",") : "1";
  return `${minute} ${hour} * * ${dayList}`;
}

function parseCron(cron: string | null): {
  frequency: ScheduleFrequency;
  time: string;
  days: string[];
} {
  if (!cron) {
    return { frequency: "daily", time: "05:00", days: ["1"] };
  }

  const parts = cron.split(" ");
  if (parts.length < 5) {
    return { frequency: "daily", time: "05:00", days: ["1"] };
  }

  const [minute, hour, , , dayOfWeek] = parts;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  if (dayOfWeek === "*") {
    return { frequency: "daily", time, days: ["1"] };
  }

  const days = dayOfWeek.split(",").filter(Boolean);
  return { frequency: "weekly", time, days: days.length > 0 ? days : ["1"] };
}

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

  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleFrequency, setScheduleFrequency] = useState<ScheduleFrequency>("daily");
  const [scheduleTime, setScheduleTime] = useState("05:00");
  const [scheduleDays, setScheduleDays] = useState<string[]>(["1"]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  const site = data?.site;

  useEffect(() => {
    if (!site) {
      return;
    }

    setName(site.name);
    setUrl(site.url);

    const parsed = parseCron(site.scheduleCron ?? null);
    setScheduleEnabled(site.scheduleEnabled ?? false);
    setScheduleFrequency(parsed.frequency);
    setScheduleTime(parsed.time);
    setScheduleDays(parsed.days);
  }, [site?.scheduleCron, site?.scheduleEnabled]);

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

  const scheduleMutation = useMutation({
    mutationFn: (payload: { scheduleEnabled: boolean; scheduleCron: string | null }) =>
      sitesApi.update(siteId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      queryClient.invalidateQueries({ queryKey: ["sites", siteId] });
    },
  });

  const basicInfoMutation = useMutation({
    mutationFn: (payload: { name: string; url: string }) => sitesApi.update(siteId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      queryClient.invalidateQueries({ queryKey: ["sites", siteId] });
    },
  });

  if (isLoading) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (error || !site) {
    return (
      <div className="p-8">
        <p className="text-destructive">Failed to load site</p>
      </div>
    );
  }

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
            <h2 className="text-lg font-semibold mb-4">Basic Information</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-muted-foreground mb-1">Site Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 border border-input rounded-md bg-background"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">URL</label>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="w-full px-3 py-2 border border-input rounded-md bg-background"
                  required
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  basicInfoMutation.mutate({
                    name: name.trim(),
                    url: url.trim(),
                  });
                }}
                disabled={
                  basicInfoMutation.isPending ||
                  name.trim().length === 0 ||
                  url.trim().length === 0
                }
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
              >
                {basicInfoMutation.isPending ? "Saving..." : "Update Site"}
              </button>
            </div>
          </div>

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
            </dl>
          </div>

          <div className="bg-card border border-border rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">Schedule</h2>
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="scheduleEnabled"
                  checked={scheduleEnabled}
                  onChange={(e) => setScheduleEnabled(e.target.checked)}
                  className="rounded"
                />
                <label htmlFor="scheduleEnabled" className="text-sm">
                  Enable scheduled crawls
                </label>
              </div>

              {scheduleEnabled ? (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1">Frequency</label>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => setScheduleFrequency("daily")}
                        className={`px-3 py-2 rounded-md text-sm border ${
                          scheduleFrequency === "daily"
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background border-input"
                        }`}
                      >
                        Daily
                      </button>
                      <button
                        type="button"
                        onClick={() => setScheduleFrequency("weekly")}
                        className={`px-3 py-2 rounded-md text-sm border ${
                          scheduleFrequency === "weekly"
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background border-input"
                        }`}
                      >
                        Weekly
                      </button>
                    </div>
                  </div>

                  {scheduleFrequency === "weekly" && (
                    <div>
                      <label className="block text-sm font-medium mb-1">Days</label>
                      <div className="flex flex-wrap gap-2">
                        {WEEKDAYS.map((day) => {
                          const isSelected = scheduleDays.includes(day.value);
                          return (
                            <button
                              key={day.value}
                              type="button"
                              onClick={() => {
                                const next = isSelected
                                  ? scheduleDays.filter((d) => d !== day.value)
                                  : [...scheduleDays, day.value];
                                setScheduleDays(next.length > 0 ? next : ["1"]);
                              }}
                              className={`px-2 py-1 rounded-md text-xs border ${
                                isSelected
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : "bg-background border-input"
                              }`}
                            >
                              {day.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium mb-1">Time</label>
                    <input
                      type="time"
                      value={scheduleTime}
                      onChange={(e) => setScheduleTime(e.target.value)}
                      className="w-full px-3 py-2 border border-input rounded-md bg-background"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Times are interpreted in the server timezone (UTC on Railway)
                    </p>
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground text-sm">Scheduling disabled</p>
              )}

              <div>
                <label className="block text-sm font-medium mb-1">Generated Cron</label>
                <div className="px-3 py-2 border border-input rounded-md bg-muted/30 font-mono text-sm">
                  {scheduleEnabled
                    ? toCronExpression(scheduleFrequency, scheduleTime, scheduleDays) || "Invalid time"
                    : "—"}
                </div>
              </div>

              {site.nextScheduledAt && (
                <div>
                  <label className="block text-sm font-medium mb-1">Next Run</label>
                  <div className="text-sm text-muted-foreground">
                    {new Date(site.nextScheduledAt).toLocaleString()}
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  const scheduleCron = scheduleEnabled
                    ? toCronExpression(scheduleFrequency, scheduleTime, scheduleDays)
                    : null;

                  scheduleMutation.mutate({
                    scheduleEnabled,
                    scheduleCron,
                  });
                }}
                disabled={scheduleMutation.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
              >
                {scheduleMutation.isPending ? "Saving..." : "Update Schedule"}
              </button>
            </div>
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
