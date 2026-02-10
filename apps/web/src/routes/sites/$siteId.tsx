import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { sitesApi, crawlsApi } from "@/lib/api";
import { formatToMountainTime } from "@/lib/date";
import { ArrowLeft, Play, ExternalLink, Trash2, Download, Save } from "lucide-react";
import { useEffect, useState } from "react";

type ScheduleFrequency = "daily" | "weekly" | "monthly";

const WEEKDAYS = [
  { label: "Sun", value: "0" },
  { label: "Mon", value: "1" },
  { label: "Tue", value: "2" },
  { label: "Wed", value: "3" },
  { label: "Thu", value: "4" },
  { label: "Fri", value: "5" },
  { label: "Sat", value: "6" },
];

function toCronExpression(frequency: ScheduleFrequency, time: string, days: string[], monthlyDay?: string): string | null {
  const [hourString, minuteString] = time.split(":");
  const hour = Number.parseInt(hourString, 10);
  const minute = Number.parseInt(minuteString, 10);

  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  if (frequency === "daily") {
    return `${minute} ${hour} * * *`;
  }

  if (frequency === "monthly") {
    const dayOfMonth = monthlyDay || "1";
    return `${minute} ${hour} ${dayOfMonth} * *`;
  }

  const dayList = days.length > 0 ? days.join(",") : "1";
  return `${minute} ${hour} * * ${dayList}`;
}

function parseCron(cron: string | null): {
  frequency: ScheduleFrequency;
  time: string;
  days: string[];
  monthlyDay: string;
} {
  if (!cron) {
    return { frequency: "daily", time: "05:00", days: ["1"], monthlyDay: "1" };
  }

  const parts = cron.split(" ");
  if (parts.length < 5) {
    return { frequency: "daily", time: "05:00", days: ["1"], monthlyDay: "1" };
  }

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  // If dayOfMonth is not "*" and dayOfWeek is "*", it's monthly
  if (dayOfMonth !== "*" && dayOfWeek === "*") {
    return { frequency: "monthly", time, days: ["1"], monthlyDay: dayOfMonth };
  }

  if (dayOfWeek === "*") {
    return { frequency: "daily", time, days: ["1"], monthlyDay: "1" };
  }

  const days = dayOfWeek.split(",").filter(Boolean);
  return { frequency: "weekly", time, days: days.length > 0 ? days : ["1"], monthlyDay: "1" };
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
    refetchInterval: 10000,
  });

  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleFrequency, setScheduleFrequency] = useState<ScheduleFrequency>("daily");
  const [scheduleTime, setScheduleTime] = useState("05:00");
  const [scheduleDays, setScheduleDays] = useState<string[]>(["1"]);
  const [scheduleMonthlyDay, setScheduleMonthlyDay] = useState<string>("1");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [concurrency, setConcurrency] = useState(5);
  const [maxPagesInput, setMaxPagesInput] = useState("");
  const [maxArchivesToKeepInput, setMaxArchivesToKeepInput] = useState("");
  const [removeWebflowBadge, setRemoveWebflowBadge] = useState(true);
  const [downloadBlacklistText, setDownloadBlacklistText] = useState("");

  const site = data?.site;

  useEffect(() => {
    if (!site) {
      return;
    }

    setName(site.name);
    setUrl(site.url);
    setConcurrency(site.concurrency ?? 5);
    setMaxPagesInput(site.maxPages ? String(site.maxPages) : "");
    setMaxArchivesToKeepInput(
      site.maxArchivesToKeep && site.maxArchivesToKeep > 0 ? String(site.maxArchivesToKeep) : ""
    );
    setRemoveWebflowBadge(site.removeWebflowBadge ?? true);
    setDownloadBlacklistText((site.downloadBlacklist ?? []).join("\n"));

    const parsed = parseCron(site.scheduleCron ?? null);
    setScheduleEnabled(site.scheduleEnabled ?? false);
    setScheduleFrequency(parsed.frequency);
    setScheduleTime(parsed.time);
    setScheduleDays(parsed.days);
    setScheduleMonthlyDay(parsed.monthlyDay);
  }, [site]);

  const configurationMutation = useMutation({
    mutationFn: (payload: {
      concurrency: number;
      maxPages: number | null;
      maxArchivesToKeep: number | null;
      removeWebflowBadge: boolean;
      downloadBlacklist: string[];
    }) => sitesApi.update(siteId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      queryClient.invalidateQueries({ queryKey: ["sites", siteId] });
    },
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

  if (error || !site) {
    return (
      <div className="p-8">
        <p className="text-sm font-mono" style={{ color: "#ef4444" }}>Failed to load site</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <div className="mb-6 md:mb-8">
        <Link
          to="/sites"
          className="btn-ghost btn-sm mb-4 touch-target-sm inline-flex"
        >
          <ArrowLeft size={14} />
          Back to Sites
        </Link>

        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 mb-1">
              <span className="text-xs font-mono" style={{ color: "#6366f1" }}>
                sites/{site.id.slice(0, 8)}
              </span>
            </div>
            <h1 className="text-xl md:text-2xl font-bold truncate" style={{ color: "#fafafa" }}>{site.name}</h1>
            <a
              href={site.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 mt-1 text-sm font-mono transition-colors hover:opacity-80 truncate"
              style={{ color: "#71717a" }}
            >
              <span className="truncate">{site.url}</span>
              <ExternalLink size={14} className="shrink-0" />
            </a>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => startCrawlMutation.mutate()}
              disabled={startCrawlMutation.isPending}
              className="btn-primary disabled:opacity-50 touch-target-sm"
            >
              <Play size={16} />
              {startCrawlMutation.isPending ? "Starting..." : "Start Crawl"}
            </motion.button>
            <button
              onClick={() => {
                if (confirm("Are you sure you want to delete this site?")) {
                  deleteMutation.mutate();
                }
              }}
              className="btn-icon-danger touch-target-sm"
              aria-label="Delete site"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        {/* Configuration */}
        <div className="lg:col-span-1 space-y-6">
          <div className="card-dark p-6">
            <h2 className="text-sm font-semibold mb-4" style={{ color: "#fafafa" }}>Basic Information</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Site Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input-dark"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>URL</label>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="input-dark"
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
                className="btn-secondary btn-sm disabled:opacity-50"
              >
                <Save size={14} />
                {basicInfoMutation.isPending ? "Saving..." : "Update Site"}
              </button>
            </div>
          </div>

          <div className="card-dark p-6">
            <h2 className="text-sm font-semibold mb-4" style={{ color: "#fafafa" }}>Configuration</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Concurrency</label>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={concurrency}
                  onChange={(e) => setConcurrency(parseInt(e.target.value, 10) || 5)}
                  className="input-dark"
                />
                <p className="text-xs font-mono mt-1" style={{ color: "#52525b" }}>Pages to crawl in parallel</p>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Max Pages</label>
                <input
                  type="number"
                  min={1}
                  value={maxPagesInput}
                  onChange={(e) => setMaxPagesInput(e.target.value)}
                  className="input-dark"
                  placeholder="Unlimited"
                />
                <p className="text-xs font-mono mt-1" style={{ color: "#52525b" }}>Leave empty for unlimited</p>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>
                  Max Archives to Keep
                </label>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={maxArchivesToKeepInput}
                  onChange={(e) => setMaxArchivesToKeepInput(e.target.value)}
                  className="input-dark"
                  placeholder="Unlimited"
                />
                <p className="text-xs font-mono mt-1" style={{ color: "#52525b" }}>
                  Oldest archives are deleted after this many are kept
                </p>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="removeWebflowBadge"
                  checked={removeWebflowBadge}
                  onChange={(e) => setRemoveWebflowBadge(e.target.checked)}
                  className="rounded"
                  style={{ accentColor: "#6366f1" }}
                />
                <label htmlFor="removeWebflowBadge" className="text-sm" style={{ color: "#a1a1aa" }}>
                  Remove Webflow badge
                </label>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Download Blacklist</label>
                <p className="text-xs mb-2" style={{ color: "#52525b" }}>
                  One URL rule per line. Use <code className="code">*</code> at the end for prefix matching.
                </p>
                <textarea
                  value={downloadBlacklistText}
                  onChange={(e) => setDownloadBlacklistText(e.target.value)}
                  className="input-dark min-h-40 font-mono text-xs resize-y"
                  placeholder={"https://cdn.example.com/tracker.js\nhttps://cdn.example.com/embeds/*"}
                />
              </div>

              <button
                type="button"
                onClick={() => {
                  const parsedMaxPages = maxPagesInput.trim() ? parseInt(maxPagesInput.trim(), 10) : null;
                  const parsedMaxArchivesToKeep = maxArchivesToKeepInput.trim()
                    ? parseInt(maxArchivesToKeepInput.trim(), 10)
                    : null;
                  const rules = downloadBlacklistText
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0);
                  configurationMutation.mutate({
                    concurrency: Math.max(1, Math.min(30, concurrency)),
                    maxPages:
                      parsedMaxPages && !Number.isNaN(parsedMaxPages) && parsedMaxPages > 0
                        ? parsedMaxPages
                        : null,
                    maxArchivesToKeep:
                      parsedMaxArchivesToKeep &&
                      !Number.isNaN(parsedMaxArchivesToKeep) &&
                      parsedMaxArchivesToKeep > 0
                        ? parsedMaxArchivesToKeep
                        : null,
                    removeWebflowBadge,
                    downloadBlacklist: rules,
                  });
                }}
                disabled={configurationMutation.isPending || concurrency < 1 || concurrency > 30}
                className="btn-secondary btn-sm disabled:opacity-50"
              >
                <Save size={14} />
                {configurationMutation.isPending ? "Saving..." : "Update Configuration"}
              </button>
            </div>
          </div>

          <div className="card-dark p-6">
            <h2 className="text-sm font-semibold mb-4" style={{ color: "#fafafa" }}>Schedule</h2>
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="scheduleEnabled"
                  checked={scheduleEnabled}
                  onChange={(e) => setScheduleEnabled(e.target.checked)}
                  className="rounded"
                  style={{ accentColor: "#6366f1" }}
                />
                <label htmlFor="scheduleEnabled" className="text-sm" style={{ color: "#a1a1aa" }}>
                  Enable scheduled crawls
                </label>
              </div>

              {scheduleEnabled ? (
                <>
                  <div>
                    <label className="block text-xs font-medium mb-2" style={{ color: "#71717a" }}>Frequency</label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setScheduleFrequency("daily")}
                        className={scheduleFrequency === "daily" ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
                      >
                        Daily
                      </button>
                      <button
                        type="button"
                        onClick={() => setScheduleFrequency("weekly")}
                        className={scheduleFrequency === "weekly" ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
                      >
                        Weekly
                      </button>
                      <button
                        type="button"
                        onClick={() => setScheduleFrequency("monthly")}
                        className={scheduleFrequency === "monthly" ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
                      >
                        Monthly
                      </button>
                    </div>
                  </div>

                  {scheduleFrequency === "weekly" && (
                    <div>
                      <label className="block text-xs font-medium mb-2" style={{ color: "#71717a" }}>Days</label>
                      <div className="flex flex-wrap gap-1.5">
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
                              className="px-2.5 py-1 rounded-md text-xs font-medium transition-all"
                              style={{
                                backgroundColor: isSelected ? "#6366f1" : "#18181b",
                                color: isSelected ? "white" : "#a1a1aa",
                                border: `1px solid ${isSelected ? "#6366f1" : "#27272a"}`,
                              }}
                            >
                              {day.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {scheduleFrequency === "monthly" && (
                    <div>
                      <label className="block text-xs font-medium mb-2" style={{ color: "#71717a" }}>Day of Month</label>
                      <select
                        value={scheduleMonthlyDay}
                        onChange={(e) => setScheduleMonthlyDay(e.target.value)}
                        className="input-dark"
                      >
                        {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                          <option key={day} value={String(day)}>
                            {day}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs font-mono mt-1" style={{ color: "#52525b" }}>
                        Day of the month when the crawl will run
                      </p>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Time</label>
                    <input
                      type="time"
                      value={scheduleTime}
                      onChange={(e) => setScheduleTime(e.target.value)}
                      className="input-dark"
                    />
                    <p className="text-xs font-mono mt-1" style={{ color: "#52525b" }}>
                      Times are interpreted in the server timezone (UTC on Railway)
                    </p>
                  </div>
                </>
              ) : (
                <p className="text-sm" style={{ color: "#52525b" }}>Scheduling disabled</p>
              )}

              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Generated Cron</label>
                <div className="input-dark font-mono text-sm" style={{ backgroundColor: "#09090b" }}>
                  {scheduleEnabled
                    ? toCronExpression(scheduleFrequency, scheduleTime, scheduleDays, scheduleMonthlyDay) || "Invalid time"
                    : "\u2014"}
                </div>
              </div>

              {site.nextScheduledAt && (
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Next Run</label>
                  <div className="text-sm font-mono" style={{ color: "#a1a1aa" }}>
                    {formatToMountainTime(site.nextScheduledAt)}
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  const scheduleCron = scheduleEnabled
                    ? toCronExpression(scheduleFrequency, scheduleTime, scheduleDays, scheduleMonthlyDay)
                    : null;

                  scheduleMutation.mutate({
                    scheduleEnabled,
                    scheduleCron,
                  });
                }}
                disabled={scheduleMutation.isPending}
                className="btn-secondary btn-sm disabled:opacity-50"
              >
                <Save size={14} />
                {scheduleMutation.isPending ? "Saving..." : "Update Schedule"}
              </button>
            </div>
          </div>
        </div>

        {/* Crawl History */}
        <div className="lg:col-span-2">
          <div className="card-dark p-6">
            <h2 className="text-sm font-semibold mb-4" style={{ color: "#fafafa" }}>Crawl History</h2>

            {site.crawls.length === 0 ? (
              <div
                className="text-center py-8 rounded-lg"
                style={{ backgroundColor: "#09090b", border: "1px dashed #27272a" }}
              >
                <p className="text-xs font-mono" style={{ color: "#71717a" }}>No crawls yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {site.crawls.map((crawl) => (
                  <Link
                    key={crawl.id}
                    to="/crawls/$crawlId"
                    params={{ crawlId: crawl.id }}
                    className="flex items-center justify-between p-4 rounded-lg transition-colors"
                    style={{ backgroundColor: "#09090b", border: "1px solid #27272a" }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = "#18181b";
                      e.currentTarget.style.borderColor = "#3f3f46";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = "#09090b";
                      e.currentTarget.style.borderColor = "#27272a";
                    }}
                  >
                    <div>
                      <div className="flex items-center gap-3">
                        <StatusBadge status={crawl.status || "unknown"} />
                        <span className="text-xs font-mono" style={{ color: "#71717a" }}>
                          {formatToMountainTime(crawl.createdAt)}
                        </span>
                      </div>
                      <p className="text-sm mt-1.5 font-mono" style={{ color: "#a1a1aa" }}>
                        {crawl.succeededPages ?? 0} / {crawl.totalPages ?? "?"} pages
                        {crawl.failedPages ? ` (${crawl.failedPages} failed)` : ""}
                      </p>
                    </div>
                    {crawl.status === "completed" &&
                      crawl.outputPath?.endsWith(".zip") &&
                      (crawl.outputSizeBytes ?? 0) > 0 && (
                      <div className="flex items-center gap-2">
                        <a
                          href={crawlsApi.getDownloadUrl(crawl.id)}
                          className="btn-secondary btn-sm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Download size={14} />
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
  const styles: Record<string, { bg: string; color: string }> = {
    pending: { bg: "rgba(245, 158, 11, 0.15)", color: "#fbbf24" },
    running: { bg: "rgba(59, 130, 246, 0.15)", color: "#60a5fa" },
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
        className={`w-1 h-1 rounded-full ${status === "running" ? "animate-pulse" : ""}`}
        style={{
          backgroundColor: style.color,
          boxShadow: status === "running" ? `0 0 6px ${style.color}` : undefined,
        }}
      />
      {status}
    </span>
  );
}
