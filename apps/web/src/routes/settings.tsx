import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { settingsApi } from "@/lib/api";
import { useState, useEffect } from "react";
import { Save, Check, Shield, Sliders, RotateCcw } from "lucide-react";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: settingsApi.get,
  });

  const [formData, setFormData] = useState({
    defaultConcurrency: 5,
    defaultMaxPages: "",
    globalDownloadBlacklist: "",
  });
  const defaultGlobalBlacklist = (data?.defaults?.globalDownloadBlacklist || []).join("\n");

  useEffect(() => {
    if (data?.settings) {
      const resolvedGlobalBlacklist =
        ((data.settings.globalDownloadBlacklist as string[]) || data.defaults?.globalDownloadBlacklist || []);
      setFormData({
        defaultConcurrency: (data.settings.defaultConcurrency as number) || 5,
        defaultMaxPages: (data.settings.defaultMaxPages as string) || "",
        globalDownloadBlacklist: resolvedGlobalBlacklist.join("\n"),
      });
    }
  }, [data]);

  const updateMutation = useMutation({
    mutationFn: settingsApi.update,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateMutation.mutate({
      defaultConcurrency: formData.defaultConcurrency,
      defaultMaxPages: formData.defaultMaxPages,
      globalDownloadBlacklist: formData.globalDownloadBlacklist
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    });
  };

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

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mb-6 md:mb-8"
      >
        <span className="text-xs font-mono" style={{ color: "#6366f1" }}>
          settings/global
        </span>
        <h1 className="text-xl md:text-2xl font-bold mt-1 mb-1" style={{ color: "#fafafa" }}>
          Settings
        </h1>
        <p className="text-sm" style={{ color: "#71717a" }}>
          Configure global application preferences and defaults
        </p>
      </motion.div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Default Scrape Settings */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.3 }}
          className="card-dark p-6 space-y-6"
        >
          <div className="flex items-center gap-3 mb-2">
            <div
              className="p-2 rounded-lg"
              style={{ backgroundColor: "rgba(99, 102, 241, 0.1)" }}
            >
              <Sliders size={18} style={{ color: "#818cf8" }} />
            </div>
            <div>
              <h2 className="text-sm font-semibold" style={{ color: "#fafafa" }}>
                Default Scrape Settings
              </h2>
              <p className="text-xs" style={{ color: "#71717a" }}>
                These defaults are used when creating new sites
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-6">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>
                Default Concurrency
              </label>
              <input
                type="number"
                min={1}
                max={30}
                value={formData.defaultConcurrency}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    defaultConcurrency: parseInt(e.target.value) || 5,
                  })
                }
                className="input-dark touch-target-sm"
                aria-label="Default concurrency"
              />
              <p className="text-xs font-mono mt-1" style={{ color: "#52525b" }}>
                Number of parallel requests (1-30)
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "#71717a" }}>
                Default Max Pages
              </label>
              <input
                type="number"
                min={1}
                value={formData.defaultMaxPages}
                onChange={(e) =>
                  setFormData({ ...formData, defaultMaxPages: e.target.value })
                }
                className="input-dark touch-target-sm"
                placeholder="Unlimited"
                aria-label="Default max pages"
              />
              <p className="text-xs font-mono mt-1" style={{ color: "#52525b" }}>
                Leave empty for unlimited
              </p>
            </div>
          </div>
        </motion.div>

        {/* Global Download Blacklist */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.3 }}
          className="card-dark p-6 space-y-4"
        >
          <div className="flex items-center gap-3 mb-2">
            <div
              className="p-2 rounded-lg"
              style={{ backgroundColor: "rgba(239, 68, 68, 0.1)" }}
            >
              <Shield size={18} style={{ color: "#f87171" }} />
            </div>
            <div>
              <h2 className="text-sm font-semibold" style={{ color: "#fafafa" }}>
                Global Download Blacklist
              </h2>
              <p className="text-xs" style={{ color: "#71717a" }}>
                URLs to exclude from all crawls
              </p>
            </div>
          </div>

          <div
            className="p-3 rounded-lg text-sm"
            style={{ backgroundColor: "#09090b", border: "1px solid #27272a" }}
          >
            <p style={{ color: "#71717a" }}>
              One rule per line. Use a full URL or a URL prefix ending with{" "}
              <code className="code">*</code>.
            </p>
            <p className="text-xs font-mono mt-1.5" style={{ color: "#52525b" }}>
              Built-in defaults are included automatically. Saving custom rules will not remove
              core defaults.
            </p>
          </div>

          <textarea
            value={formData.globalDownloadBlacklist}
            onChange={(e) =>
              setFormData({
                ...formData,
                globalDownloadBlacklist: e.target.value,
              })
            }
            className="input-dark min-h-40 font-mono text-xs resize-y"
            placeholder={"https://example.com/tracker.js\ndomain:example-tracker.com"}
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() =>
                setFormData({
                  ...formData,
                  globalDownloadBlacklist: defaultGlobalBlacklist,
                })
              }
              className="btn-ghost btn-sm touch-target-sm"
            >
              <RotateCcw size={14} />
              <span className="hidden sm:inline">Reset to Defaults</span>
              <span className="sm:hidden">Reset</span>
            </button>
          </div>
        </motion.div>

        {/* Save Button */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.3 }}
          className="flex items-center justify-end gap-4 pt-2"
        >
          <motion.button
            type="submit"
            disabled={updateMutation.isPending}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className={`${saved ? "btn-success" : "btn-primary"} disabled:opacity-50 touch-target-sm`}
          >
            {saved ? (
              <>
                <Check size={16} />
                <span className="hidden sm:inline">Saved Successfully</span>
                <span className="sm:hidden">Saved</span>
              </>
            ) : (
              <>
                <Save size={16} />
                {updateMutation.isPending ? "Saving..." : "Save Settings"}
              </>
            )}
          </motion.button>
        </motion.div>
      </form>
    </div>
  );
}
