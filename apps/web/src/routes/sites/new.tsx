import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { sitesApi, type CreateSiteInput } from "@/lib/api";
import { useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { Link } from "@tanstack/react-router";

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

  // Convert from Mountain Time to UTC (UTC = MT + 7 hours)
  const utcHour = (hour + 7) % 24;

  if (frequency === "daily") {
    return `${minute} ${utcHour} * * *`;
  }

  if (frequency === "monthly") {
    const dayOfMonth = monthlyDay || "1";
    return `${minute} ${utcHour} ${dayOfMonth} * *`;
  }

  const dayList = days.length > 0 ? days.join(",") : "1";
  return `${minute} ${utcHour} * * ${dayList}`;
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
    maxArchivesToKeep: null,
    removeWebflowBadge: true,
    scheduleEnabled: false,
  });

  const [scheduleFrequency, setScheduleFrequency] = useState<ScheduleFrequency>("daily");
  const [scheduleTime, setScheduleTime] = useState("05:00");
  const [scheduleDays, setScheduleDays] = useState<string[]>(["1"]);
  const [scheduleMonthlyDay, setScheduleMonthlyDay] = useState<string>("1");

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
      ? toCronExpression(scheduleFrequency, scheduleTime, scheduleDays, scheduleMonthlyDay)
      : null;

    createMutation.mutate({
      ...formData,
      scheduleCron,
    });
  };

  const cronPreview = formData.scheduleEnabled
    ? toCronExpression(scheduleFrequency, scheduleTime, scheduleDays, scheduleMonthlyDay)
    : null;

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto">
      <div className="mb-6 md:mb-8">
        <Link
          to="/sites"
          className="btn-ghost btn-sm mb-4 touch-target-sm inline-flex"
        >
          <ArrowLeft size={14} />
          Back to Sites
        </Link>
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <span className="text-xs font-mono" style={{ color: "#6366f1" }}>
            sites/new
          </span>
          <h1 className="text-xl md:text-2xl font-bold mt-1" style={{ color: "#fafafa" }}>Add New Site</h1>
          <p className="text-sm mt-1" style={{ color: "#71717a" }}>Configure a new Webflow site to archive</p>
        </motion.div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="card-dark p-6 space-y-4">
          <h2 className="text-sm font-semibold" style={{ color: "#fafafa" }}>Basic Information</h2>

          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Site Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="input-dark"
              placeholder="My Webflow Site"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>URL</label>
            <input
              type="url"
              value={formData.url}
              onChange={(e) => setFormData({ ...formData, url: e.target.value })}
              className="input-dark"
              placeholder="https://example.webflow.io"
              required
            />
            <p className="text-xs font-mono mt-1" style={{ color: "#52525b" }}>
              The root URL of the Webflow site to crawl
            </p>
          </div>
        </div>

        <div className="card-dark p-4 md:p-6 space-y-4">
          <h2 className="text-sm font-semibold" style={{ color: "#fafafa" }}>Crawl Settings</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Concurrency</label>
              <input
                type="number"
                min={1}
                max={30}
                value={formData.concurrency || 5}
                onChange={(e) =>
                  setFormData({ ...formData, concurrency: parseInt(e.target.value) || 5 })
                }
                className="input-dark touch-target-sm"
                aria-label="Concurrency"
              />
              <p className="text-xs font-mono mt-1" style={{ color: "#52525b" }}>Pages to crawl in parallel</p>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Max Pages</label>
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
                className="input-dark touch-target-sm"
                placeholder="Unlimited"
                aria-label="Max pages"
              />
              <p className="text-xs font-mono mt-1" style={{ color: "#52525b" }}>Leave empty for unlimited</p>
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Max Archives to Keep</label>
              <input
                type="number"
                min={1}
                max={1000}
                value={formData.maxArchivesToKeep || ""}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    maxArchivesToKeep: e.target.value ? parseInt(e.target.value, 10) : null,
                  })
                }
                className="input-dark touch-target-sm sm:max-w-[50%]"
                placeholder="Unlimited"
                aria-label="Max archives to keep"
              />
              <p className="text-xs font-mono mt-1" style={{ color: "#52525b" }}>
                Oldest archives are deleted after this many are kept
              </p>
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
              style={{ accentColor: "#6366f1" }}
            />
            <label htmlFor="removeWebflowBadge" className="text-sm" style={{ color: "#a1a1aa" }}>
              Remove Webflow badge
            </label>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Site Download Blacklist (Optional)</label>
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
              className="input-dark min-h-28 font-mono text-xs resize-y"
              placeholder={"https://cdn.example.com/script.js\nhttps://cdn.example.com/embeds/*"}
            />
            <p className="text-xs font-mono mt-1" style={{ color: "#52525b" }}>
              These rules apply only to this site and are merged with global blacklist rules.
            </p>
          </div>
        </div>

        <div className="card-dark p-6 space-y-4">
          <h2 className="text-sm font-semibold" style={{ color: "#fafafa" }}>Schedule (Optional)</h2>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="scheduleEnabled"
              checked={formData.scheduleEnabled ?? false}
              onChange={(e) =>
                setFormData({ ...formData, scheduleEnabled: e.target.checked })
              }
              className="rounded"
              style={{ accentColor: "#6366f1" }}
            />
            <label htmlFor="scheduleEnabled" className="text-sm" style={{ color: "#a1a1aa" }}>
              Enable scheduled crawls
            </label>
          </div>

          {formData.scheduleEnabled && (
            <div className="space-y-4">
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
                  Time in Mountain Time (America/Denver)
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>Generated Cron</label>
                <div className="input-dark font-mono text-sm" style={{ backgroundColor: "#09090b" }}>
                  {cronPreview || "Invalid time"}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-3">
          <Link
            to="/sites"
            className="btn-ghost touch-target-sm justify-center"
          >
            Cancel
          </Link>
          <motion.button
            type="submit"
            disabled={createMutation.isPending}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="btn-primary disabled:opacity-50 touch-target-sm"
          >
            <Plus size={16} />
            {createMutation.isPending ? "Creating..." : "Create Site"}
          </motion.button>
        </div>

        {createMutation.isError && (
          <p className="text-sm font-mono" style={{ color: "#ef4444" }}>
            Failed to create site. Please try again.
          </p>
        )}
      </form>
    </div>
  );
}
