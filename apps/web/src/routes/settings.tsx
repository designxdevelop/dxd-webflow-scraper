import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { settingsApi } from "@/lib/api";
import { useState, useEffect } from "react";
import { Save, Check } from "lucide-react";

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

  useEffect(() => {
    if (data?.settings) {
      setFormData({
        defaultConcurrency: (data.settings.defaultConcurrency as number) || 5,
        defaultMaxPages: (data.settings.defaultMaxPages as string) || "",
        globalDownloadBlacklist:
          ((data.settings.globalDownloadBlacklist as string[]) || []).join("\n"),
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
      <div className="p-8">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground mt-1">Configure global application settings</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Default Scrape Settings */}
        <div className="bg-card border border-border rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Default Scrape Settings</h2>
          <p className="text-sm text-muted-foreground">
            These defaults are used when creating new sites
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Default Concurrency</label>
              <input
                type="number"
                min={1}
                max={20}
                value={formData.defaultConcurrency}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    defaultConcurrency: parseInt(e.target.value) || 5,
                  })
                }
                className="w-full px-3 py-2 border border-input rounded-md bg-background"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Default Max Pages</label>
              <input
                type="number"
                min={1}
                value={formData.defaultMaxPages}
                onChange={(e) =>
                  setFormData({ ...formData, defaultMaxPages: e.target.value })
                }
                className="w-full px-3 py-2 border border-input rounded-md bg-background"
                placeholder="Unlimited"
              />
            </div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Global Download Blacklist</h2>
          <p className="text-sm text-muted-foreground">
            One rule per line. Use a full URL or a URL prefix ending with <code>*</code>.
          </p>
          <textarea
            value={formData.globalDownloadBlacklist}
            onChange={(e) =>
              setFormData({
                ...formData,
                globalDownloadBlacklist: e.target.value,
              })
            }
            className="w-full min-h-40 px-3 py-2 border border-input rounded-md bg-background font-mono text-xs"
            placeholder={"https://js.partnerstack.com/partnerstack.min.js\nhttps://cdn.taboola.com/resources/codeless/*"}
          />
        </div>

        <div className="flex items-center justify-end gap-4">
          <button
            type="submit"
            disabled={updateMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
          >
            {saved ? (
              <>
                <Check size={18} />
                Saved
              </>
            ) : (
              <>
                <Save size={18} />
                {updateMutation.isPending ? "Saving..." : "Save Settings"}
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
