import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sitesApi, type CreateSiteInput } from "@/lib/api";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "@tanstack/react-router";

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

export const Route = createFileRoute("/sites/new")({
  component: NewSitePage,
});

function NewSitePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState<CreateSiteInput>({
    name: "",
    url: "",
    concurrency: 30,
    maxPages: null,
    removeWebflowBadge: true,
    scheduleEnabled: false,
  });

  const [scheduleFrequency, setScheduleFrequency] = useState<ScheduleFrequency>("daily");
  const [scheduleTime, setScheduleTime] = useState("05:00");
  const [scheduleDays, setScheduleDays] = useState<string[]>(["1"]);

  const createMutation = useMutation({
    mutationFn: sitesApi.create,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      navigate({ to: "/sites/$siteId", params: { siteId: data.site.id } });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const scheduleCron = formData.scheduleEnabled
      ? toCronExpression(scheduleFrequency, scheduleTime, scheduleDays)
      : null;

    createMutation.mutate({
      ...formData,
      scheduleCron,
    });
  };

  const cronPreview = formData.scheduleEnabled
    ? toCronExpression(scheduleFrequency, scheduleTime, scheduleDays)
    : null;

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-8">
        <Link
          to="/sites"
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft size={16} />
          Back to Sites
        </Link>
        <h1 className="text-2xl font-bold text-foreground">Add New Site</h1>
        <p className="text-muted-foreground mt-1">Configure a new Webflow site to archive</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-card border border-border rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Basic Information</h2>

          <div>
            <label className="block text-sm font-medium mb-1">Site Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 border border-input rounded-md bg-background"
              placeholder="My Webflow Site"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">URL</label>
            <input
              type="url"
              value={formData.url}
              onChange={(e) => setFormData({ ...formData, url: e.target.value })}
              className="w-full px-3 py-2 border border-input rounded-md bg-background"
              placeholder="https://example.webflow.io"
              required
            />
            <p className="text-xs text-muted-foreground mt-1">
              The root URL of the Webflow site to crawl
            </p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Crawl Settings</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Concurrency</label>
              <input
                type="number"
                min={1}
                max={30}
                value={formData.concurrency || 5}
                onChange={(e) =>
                  setFormData({ ...formData, concurrency: parseInt(e.target.value) || 5 })
                }
                className="w-full px-3 py-2 border border-input rounded-md bg-background"
              />
              <p className="text-xs text-muted-foreground mt-1">Pages to crawl in parallel</p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Max Pages</label>
              <input
                type="number"
                min={1}
                value={formData.maxPages || ""}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    maxPages: e.target.value ? parseInt(e.target.value) : null,
                  })
                }
                className="w-full px-3 py-2 border border-input rounded-md bg-background"
                placeholder="Unlimited"
              />
              <p className="text-xs text-muted-foreground mt-1">Leave empty for unlimited</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="removeWebflowBadge"
              checked={formData.removeWebflowBadge ?? true}
              onChange={(e) =>
                setFormData({ ...formData, removeWebflowBadge: e.target.checked })
              }
              className="rounded"
            />
            <label htmlFor="removeWebflowBadge" className="text-sm">
              Remove Webflow badge
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Site Download Blacklist (Optional)</label>
            <textarea
              value={(formData.downloadBlacklist || []).join("\n")}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  downloadBlacklist: e.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0),
                })
              }
              className="w-full min-h-28 px-3 py-2 border border-input rounded-md bg-background font-mono text-xs"
              placeholder={"https://cdn.example.com/script.js\nhttps://cdn.example.com/embeds/*"}
            />
            <p className="text-xs text-muted-foreground mt-1">
              These rules apply only to this site and are merged with global blacklist rules.
            </p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Schedule (Optional)</h2>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="scheduleEnabled"
              checked={formData.scheduleEnabled ?? false}
              onChange={(e) =>
                setFormData({ ...formData, scheduleEnabled: e.target.checked })
              }
              className="rounded"
            />
            <label htmlFor="scheduleEnabled" className="text-sm">
              Enable scheduled crawls
            </label>
          </div>

          {formData.scheduleEnabled && (
            <div className="space-y-4">
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

              <div>
                <label className="block text-sm font-medium mb-1">Generated Cron</label>
                <div className="px-3 py-2 border border-input rounded-md bg-muted/30 font-mono text-sm">
                  {cronPreview || "Invalid time"}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-4">
          <Link
            to="/sites"
            className="px-4 py-2 text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
          >
            {createMutation.isPending ? "Creating..." : "Create Site"}
          </button>
        </div>

        {createMutation.isError && (
          <p className="text-sm text-destructive">
            Failed to create site. Please try again.
          </p>
        )}
      </form>
    </div>
  );
}
