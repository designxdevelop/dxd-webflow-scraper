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
    storageType: "local",
    localStoragePath: "./data",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3Bucket: "",
    s3Region: "auto",
  });

  useEffect(() => {
    if (data?.settings) {
      setFormData({
        defaultConcurrency: (data.settings.defaultConcurrency as number) || 5,
        defaultMaxPages: (data.settings.defaultMaxPages as string) || "",
        storageType: (data.settings.storageType as string) || "local",
        localStoragePath: (data.settings.localStoragePath as string) || "./data",
        s3Endpoint: (data.settings.s3Endpoint as string) || "",
        s3AccessKeyId: (data.settings.s3AccessKeyId as string) || "",
        s3SecretAccessKey: (data.settings.s3SecretAccessKey as string) || "",
        s3Bucket: (data.settings.s3Bucket as string) || "",
        s3Region: (data.settings.s3Region as string) || "auto",
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
    updateMutation.mutate(formData);
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

        {/* Storage Settings */}
        <div className="bg-card border border-border rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Storage</h2>
          <p className="text-sm text-muted-foreground">
            Configure where archived sites are stored
          </p>

          <div>
            <label className="block text-sm font-medium mb-1">Storage Type</label>
            <select
              value={formData.storageType}
              onChange={(e) => setFormData({ ...formData, storageType: e.target.value })}
              className="w-full px-3 py-2 border border-input rounded-md bg-background"
            >
              <option value="local">Local Filesystem</option>
              <option value="s3">S3 / R2 Compatible</option>
            </select>
          </div>

          {formData.storageType === "local" && (
            <div>
              <label className="block text-sm font-medium mb-1">Storage Path</label>
              <input
                type="text"
                value={formData.localStoragePath}
                onChange={(e) =>
                  setFormData({ ...formData, localStoragePath: e.target.value })
                }
                className="w-full px-3 py-2 border border-input rounded-md bg-background"
                placeholder="./data"
              />
            </div>
          )}

          {formData.storageType === "s3" && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Endpoint URL</label>
                <input
                  type="url"
                  value={formData.s3Endpoint}
                  onChange={(e) => setFormData({ ...formData, s3Endpoint: e.target.value })}
                  className="w-full px-3 py-2 border border-input rounded-md bg-background"
                  placeholder="https://xxx.r2.cloudflarestorage.com"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Access Key ID</label>
                  <input
                    type="text"
                    value={formData.s3AccessKeyId}
                    onChange={(e) =>
                      setFormData({ ...formData, s3AccessKeyId: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-input rounded-md bg-background"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Secret Access Key</label>
                  <input
                    type="password"
                    value={formData.s3SecretAccessKey}
                    onChange={(e) =>
                      setFormData({ ...formData, s3SecretAccessKey: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-input rounded-md bg-background"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Bucket</label>
                  <input
                    type="text"
                    value={formData.s3Bucket}
                    onChange={(e) => setFormData({ ...formData, s3Bucket: e.target.value })}
                    className="w-full px-3 py-2 border border-input rounded-md bg-background"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Region</label>
                  <input
                    type="text"
                    value={formData.s3Region}
                    onChange={(e) => setFormData({ ...formData, s3Region: e.target.value })}
                    className="w-full px-3 py-2 border border-input rounded-md bg-background"
                    placeholder="auto"
                  />
                </div>
              </div>
            </div>
          )}
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
