// API client for the backend
const API_URL = import.meta.env.VITE_API_URL || "";
const API_BASE = `${API_URL}/api`;

// Helper to make authenticated requests
async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      ...options.headers,
    },
  });
}

export interface Site {
  id: string;
  name: string;
  url: string;
  concurrency: number | null;
  maxPages: number | null;
  excludePatterns: string[] | null;
  downloadBlacklist: string[] | null;
  removeWebflowBadge: boolean | null;
  maxArchivesToKeep: number | null;
  redirectsCsv: string | null;
  scheduleEnabled: boolean | null;
  scheduleCron: string | null;
  nextScheduledAt: string | null;
  storageType: string | null;
  storagePath: string | null;
  createdAt: string;
  updatedAt: string;
  lastCrawl?: Crawl | null;
}

export interface Crawl {
  id: string;
  siteId: string | null;
  status: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalPages: number | null;
  succeededPages: number | null;
  failedPages: number | null;
  outputPath: string | null;
  outputSizeBytes: number | null;
  errorMessage: string | null;
  createdAt: string;
  site?: Site;
}

export interface CrawlLog {
  id: string;
  crawlId: string | null;
  level: string;
  message: string;
  url: string | null;
  createdAt: string;
}

export interface CreateSiteInput {
  name: string;
  url: string;
  concurrency?: number;
  maxPages?: number | null;
  excludePatterns?: string[];
  downloadBlacklist?: string[];
  removeWebflowBadge?: boolean;
  maxArchivesToKeep?: number | null;
  redirectsCsv?: string | null;
  scheduleEnabled?: boolean;
  scheduleCron?: string | null;
}

export interface UpdateSiteInput extends Partial<CreateSiteInput> {}

export interface DownloadSuggestion {
  url: string;
  count: number;
  alreadyBlacklisted: boolean;
}

// Sites API
export const sitesApi = {
  list: async (): Promise<{ sites: Site[] }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites`);
    if (!res.ok) throw new Error("Failed to fetch sites");
    return res.json();
  },

  get: async (id: string): Promise<{ site: Site & { crawls: Crawl[] } }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${id}`);
    if (!res.ok) throw new Error("Failed to fetch site");
    return res.json();
  },

  create: async (data: CreateSiteInput): Promise<{ site: Site }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error("Failed to create site");
    return res.json();
  },

  update: async (id: string, data: UpdateSiteInput): Promise<{ site: Site }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error("Failed to update site");
    return res.json();
  },

  delete: async (id: string): Promise<void> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete site");
  },

  startCrawl: async (id: string): Promise<{ crawl: Crawl }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${id}/crawl`, { method: "POST" });
    if (!res.ok) throw new Error("Failed to start crawl");
    return res.json();
  },
};

// Crawls API
export const crawlsApi = {
  list: async (params?: {
    siteId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ crawls: Crawl[] }> => {
    const searchParams = new URLSearchParams();
    if (params?.siteId) searchParams.set("siteId", params.siteId);
    if (params?.status) searchParams.set("status", params.status);
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.offset) searchParams.set("offset", params.offset.toString());

    const url = `${API_BASE}/crawls${searchParams.toString() ? `?${searchParams}` : ""}`;
    const res = await fetchWithAuth(url);
    if (!res.ok) throw new Error("Failed to fetch crawls");
    return res.json();
  },

  get: async (id: string): Promise<{ crawl: Crawl & { logs: CrawlLog[] } }> => {
    const res = await fetchWithAuth(`${API_BASE}/crawls/${id}`);
    if (!res.ok) throw new Error("Failed to fetch crawl");
    return res.json();
  },

  cancel: async (id: string): Promise<{ crawl: Crawl }> => {
    const res = await fetchWithAuth(`${API_BASE}/crawls/${id}/cancel`, { method: "POST" });
    if (!res.ok) throw new Error("Failed to cancel crawl");
    return res.json();
  },

  getDownloadUrl: (id: string): string => {
    return `${API_URL}/api/crawls/${id}/download`;
  },

  getPreviewUrl: (id: string): string => {
    return `${API_URL}/preview/${id}/`;
  },

  getDownloadSuggestions: async (
    id: string,
    params?: { minCount?: number; limit?: number }
  ): Promise<{
    crawlId: string;
    siteId: string | null;
    totalDistinctFailures: number;
    suggestions: DownloadSuggestion[];
  }> => {
    const searchParams = new URLSearchParams();
    if (params?.minCount) searchParams.set("minCount", params.minCount.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());

    const url = `${API_BASE}/crawls/${id}/download-suggestions${searchParams.toString() ? `?${searchParams}` : ""}`;
    const res = await fetchWithAuth(url);
    if (!res.ok) throw new Error("Failed to fetch download suggestions");
    return res.json();
  },

  applyDownloadSuggestions: async (
    id: string,
    urls: string[]
  ): Promise<{ success: boolean; added: number; site: Site }> => {
    const res = await fetchWithAuth(`${API_BASE}/crawls/${id}/download-suggestions/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    if (!res.ok) throw new Error("Failed to apply download suggestions");
    return res.json();
  },
};

// Settings API
export const settingsApi = {
  get: async (): Promise<{
    settings: Record<string, unknown>;
    defaults?: {
      globalDownloadBlacklist?: string[];
    };
  }> => {
    const res = await fetchWithAuth(`${API_BASE}/settings`);
    if (!res.ok) throw new Error("Failed to fetch settings");
    return res.json();
  },

  update: async (data: Record<string, unknown>): Promise<void> => {
    const res = await fetchWithAuth(`${API_BASE}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error("Failed to update settings");
  },
};

// Export API_URL for other uses
export { API_URL };
