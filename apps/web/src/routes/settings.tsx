import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { settingsApi } from "@/lib/api";
import { useState, useEffect } from "react";
import { Save, Check, Shield, Sliders } from "lucide-react";

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
      <div className="p-8 flex items-center justify-center">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
          className="w-8 h-8 border-2 rounded-full"
          style={{ borderColor: "#E8E4DE", borderTopColor: "#D4745E" }}
        />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mb-8"
      >
        <span className="text-sm font-medium tracking-wider uppercase" style={{ color: "#D4745E" }}>
          Configuration
        </span>
        <h1 className="text-4xl font-bold mt-2 mb-2" style={{ fontFamily: "Crimson Pro, serif", color: "#1A1714" }}>
          Settings
        </h1>
        <p className="text-base" style={{ color: "#8B8680" }}>
          Configure global application preferences and defaults
        </p>
      </motion.div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Default Scrape Settings */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.5 }}
          className="rounded-2xl p-6 space-y-6"
          style={{
            backgroundColor: "#FEFDFB",
            border: "1px solid #E8E4DE",
          }}
        >
          <div className="flex items-center gap-3 mb-4">
            <div
              className="p-2.5 rounded-xl"
              style={{ backgroundColor: "rgba(107, 142, 107, 0.1)" }}
            >
              <Sliders size={20} style={{ color: "#6B8E6B" }} />
            </div>
            <div>
              <h2 className="text-lg font-semibold" style={{ color: "#1A1714" }}>
                Default Scrape Settings
              </h2>
              <p className="text-sm" style={{ color: "#8B8680" }}>
                These defaults are used when creating new sites
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-semibold mb-2" style={{ color: "#4A453F" }}>
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
                className="w-full px-4 py-3 rounded-xl text-sm transition-all"
                style={{
                  backgroundColor: "#F5F2ED",
                  border: "1px solid #E8E4DE",
                  color: "#1A1714",
                }}
              />
              <p className="text-xs mt-1.5" style={{ color: "#A9A49E" }}>
                Number of parallel requests (1-30)
              </p>
            </div>

            <div>
              <label className="block text-sm font-semibold mb-2" style={{ color: "#4A453F" }}>
                Default Max Pages
              </label>
              <input
                type="number"
                min={1}
                value={formData.defaultMaxPages}
                onChange={(e) =>
                  setFormData({ ...formData, defaultMaxPages: e.target.value })
                }
                className="w-full px-4 py-3 rounded-xl text-sm transition-all"
                style={{
                  backgroundColor: "#F5F2ED",
                  border: "1px solid #E8E4DE",
                  color: "#1A1714",
                }}
                placeholder="Unlimited"
              />
              <p className="text-xs mt-1.5" style={{ color: "#A9A49E" }}>
                Leave empty for unlimited
              </p>
            </div>
          </div>
        </motion.div>

        {/* Global Download Blacklist */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="rounded-2xl p-6 space-y-4"
          style={{
            backgroundColor: "#FEFDFB",
            border: "1px solid #E8E4DE",
          }}
        >
          <div className="flex items-center gap-3 mb-4">
            <div
              className="p-2.5 rounded-xl"
              style={{ backgroundColor: "rgba(212, 116, 94, 0.1)" }}
            >
              <Shield size={20} style={{ color: "#D4745E" }} />
            </div>
            <div>
              <h2 className="text-lg font-semibold" style={{ color: "#1A1714" }}>
                Global Download Blacklist
              </h2>
              <p className="text-sm" style={{ color: "#8B8680" }}>
                URLs to exclude from all crawls
              </p>
            </div>
          </div>

          <div
            className="p-4 rounded-xl text-sm"
            style={{ backgroundColor: "#F5F2ED" }}
          >
            <p style={{ color: "#8B8680" }}>
              One rule per line. Use a full URL or a URL prefix ending with{" "}
              <code
                className="px-1.5 py-0.5 rounded text-xs font-mono"
                style={{ backgroundColor: "#E8E4DE", color: "#4A453F" }}
              >
                *
              </code>
              .
            </p>
            <p className="text-xs mt-2" style={{ color: "#A9A49E" }}>
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
            className="w-full min-h-40 px-4 py-3 rounded-xl text-sm font-mono resize-y"
            style={{
              backgroundColor: "#F5F2ED",
              border: "1px solid #E8E4DE",
              color: "#1A1714",
            }}
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
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
              style={{
                backgroundColor: "#F5F2ED",
                color: "#4A453F",
                border: "1px solid #E8E4DE",
              }}
            >
              Reset to Defaults
            </button>
          </div>
        </motion.div>

        {/* Save Button */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.5 }}
          className="flex items-center justify-end gap-4 pt-4"
        >
          <motion.button
            type="submit"
            disabled={updateMutation.isPending}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
            style={{
              backgroundColor: saved ? "#6B8E6B" : "#D4745E",
              color: "white",
            }}
          >
            {saved ? (
              <>
                <Check size={18} />
                Saved Successfully
              </>
            ) : (
              <>
                <Save size={18} />
                {updateMutation.isPending ? "Saving..." : "Save Settings"}
              </>
            )}
          </motion.button>
        </motion.div>
      </form>
    </div>
  );
}
