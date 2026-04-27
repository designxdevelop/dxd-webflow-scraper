// API client for the backend
const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
const API_BASE = `${API_URL}/api`;

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export type HostingBillingStatus = "not_sent" | "sent" | "paid" | "past_due" | "cancelled" | "internal";

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

async function parseApiResponse<T>(res: Response, defaultMessage: string): Promise<T> {
  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await res.json().catch(() => undefined) : await res.text().catch(() => undefined);

  if (!res.ok) {
    let message = defaultMessage;
    if (payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string") {
      message = payload.message;
    } else if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
      message = payload.error;
    }
    throw new ApiError(message, res.status, payload);
  }

  return payload as T;
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
  hostingAutoPublish: boolean | null;
  hostingBillingEmail: string | null;
  hostingPaymentLinkUrl: string | null;
  hostingBillingStatus: string | null;
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
  // Upload progress fields
  uploadTotalBytes: number | null;
  uploadUploadedBytes: number | null;
  uploadFilesTotal: number | null;
  uploadFilesUploaded: number | null;
  uploadCurrentFile: string | null;
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

export interface SitePublication {
  id: string;
  siteId: string;
  crawlId: string;
  status: string;
  r2Prefix: string;
  fileCount: number | null;
  totalBytes: number | null;
  errorMessage: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  crawl?: Crawl;
}

export interface SiteDomain {
  id: string;
  siteId: string;
  hostname: string;
  status: string;
  cnameTarget: string;
  activePublicationId: string | null;
  redirectEnabled: boolean | null;
  redirectTargetOrigin: string | null;
  cloudflareHostnameId: string | null;
  ownershipVerificationName: string | null;
  ownershipVerificationValue: string | null;
  sslValidationTxtName: string | null;
  sslValidationTxtValue: string | null;
  sslStatus: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  activePublication?: SitePublication | null;
}

export interface DomainDnsCheck {
  checkedAt: string;
  cname: {
    name: string;
    expected: string;
    values: string[];
    verified: boolean;
  };
  ownershipTxt: {
    name: string;
    expected: string | null;
    values: string[];
    verified: boolean;
  } | null;
  sslTxt: {
    name: string;
    expected: string | null;
    values: string[];
    verified: boolean;
  } | null;
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
  hostingAutoPublish?: boolean;
  hostingBillingEmail?: string | null;
  hostingPaymentLinkUrl?: string | null;
  hostingBillingStatus?: HostingBillingStatus;
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
    return parseApiResponse<{ sites: Site[] }>(res, "Failed to fetch sites");
  },

  get: async (id: string): Promise<{ site: Site & { crawls: Crawl[] } }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${id}`);
    return parseApiResponse<{ site: Site & { crawls: Crawl[] } }>(res, "Failed to fetch site");
  },

  create: async (data: CreateSiteInput): Promise<{ site: Site }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return parseApiResponse<{ site: Site }>(res, "Failed to create site");
  },

  update: async (id: string, data: UpdateSiteInput): Promise<{ site: Site }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return parseApiResponse<{ site: Site }>(res, "Failed to update site");
  },

  delete: async (id: string): Promise<void> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${id}`, { method: "DELETE" });
    await parseApiResponse<{ success: boolean }>(res, "Failed to delete site");
  },

  startCrawl: async (id: string): Promise<{ crawl: Crawl }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${id}/crawl`, { method: "POST" });
    return parseApiResponse<{ crawl: Crawl }>(res, "Failed to start crawl");
  },
};

export const hostingApi = {
  get: async (siteId: string): Promise<{
    cnameTarget: string | null;
    settings: {
      hostingAutoPublish: boolean;
      hostingBillingEmail: string | null;
      hostingPaymentLinkUrl: string | null;
      hostingBillingStatus: string;
    };
    publications: SitePublication[];
    domains: SiteDomain[];
  }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${siteId}/hosting`);
    return parseApiResponse<{
      cnameTarget: string | null;
      settings: {
        hostingAutoPublish: boolean;
        hostingBillingEmail: string | null;
        hostingPaymentLinkUrl: string | null;
        hostingBillingStatus: string;
      };
      publications: SitePublication[];
      domains: SiteDomain[];
    }>(res, "Failed to fetch hosting settings");
  },

  updateSettings: async (
    siteId: string,
    data: {
      hostingAutoPublish?: boolean;
      hostingBillingEmail?: string | null;
      hostingPaymentLinkUrl?: string | null;
      hostingBillingStatus?: HostingBillingStatus;
    }
  ): Promise<{
    settings: {
      hostingAutoPublish: boolean;
      hostingBillingEmail: string | null;
      hostingPaymentLinkUrl: string | null;
      hostingBillingStatus: string;
    };
  }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${siteId}/hosting`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return parseApiResponse<{
      settings: {
        hostingAutoPublish: boolean;
        hostingBillingEmail: string | null;
        hostingPaymentLinkUrl: string | null;
        hostingBillingStatus: string;
      };
    }>(res, "Failed to update hosting settings");
  },

  publish: async (
    siteId: string,
    data: { crawlId?: string; activate?: boolean }
  ): Promise<{ publication: SitePublication }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${siteId}/publications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return parseApiResponse<{ publication: SitePublication }>(res, "Failed to publish backup");
  },

  addDomain: async (siteId: string, hostname: string): Promise<{ domain: SiteDomain; alreadyExists?: boolean }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${siteId}/domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname }),
    });
    return parseApiResponse<{ domain: SiteDomain; alreadyExists?: boolean }>(res, "Failed to add domain");
  },

  syncDomain: async (siteId: string, domainId: string): Promise<{ domain: SiteDomain }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${siteId}/domains/${domainId}/sync`, { method: "POST" });
    return parseApiResponse<{ domain: SiteDomain }>(res, "Failed to sync domain");
  },

  checkDomainDns: async (siteId: string, domainId: string): Promise<{ dns: DomainDnsCheck }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${siteId}/domains/${domainId}/check`, { method: "POST" });
    return parseApiResponse<{ dns: DomainDnsCheck }>(res, "Failed to check domain DNS");
  },

  updateDomain: async (
    siteId: string,
    domainId: string,
    data: { redirectEnabled?: boolean; redirectTargetOrigin?: string | null }
  ): Promise<{ domain: SiteDomain }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${siteId}/domains/${domainId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return parseApiResponse<{ domain: SiteDomain }>(res, "Failed to update domain");
  },

  activateDomain: async (
    siteId: string,
    domainId: string,
    publicationId: string
  ): Promise<{ domain: SiteDomain }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${siteId}/domains/${domainId}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicationId }),
    });
    return parseApiResponse<{ domain: SiteDomain }>(res, "Failed to activate publication");
  },

  activatePublication: async (siteId: string, publicationId: string): Promise<{ publication: SitePublication }> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${siteId}/publications/${publicationId}/activate`, {
      method: "POST",
    });
    return parseApiResponse<{ publication: SitePublication }>(res, "Failed to activate publication");
  },

  deleteDomain: async (siteId: string, domainId: string): Promise<void> => {
    const res = await fetchWithAuth(`${API_BASE}/sites/${siteId}/domains/${domainId}`, { method: "DELETE" });
    await parseApiResponse<{ success: boolean }>(res, "Failed to delete domain");
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
    return parseApiResponse<{ crawls: Crawl[] }>(res, "Failed to fetch crawls");
  },

  get: async (id: string): Promise<{ crawl: Crawl & { logs: CrawlLog[] } }> => {
    const res = await fetchWithAuth(`${API_BASE}/crawls/${id}`);
    return parseApiResponse<{ crawl: Crawl & { logs: CrawlLog[] } }>(res, "Failed to fetch crawl");
  },

  cancel: async (id: string): Promise<{ crawl: Crawl }> => {
    const res = await fetchWithAuth(`${API_BASE}/crawls/${id}/cancel`, { method: "POST" });
    return parseApiResponse<{ crawl: Crawl }>(res, "Failed to cancel crawl");
  },

  getDownloadUrl: (id: string): string => {
    return `${API_URL}/api/crawls/${id}/download`;
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
    return parseApiResponse<{
      crawlId: string;
      siteId: string | null;
      totalDistinctFailures: number;
      suggestions: DownloadSuggestion[];
    }>(res, "Failed to fetch download suggestions");
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
    return parseApiResponse<{ success: boolean; added: number; site: Site }>(
      res,
      "Failed to apply download suggestions"
    );
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
    return parseApiResponse<{
      settings: Record<string, unknown>;
      defaults?: {
        globalDownloadBlacklist?: string[];
      };
    }>(res, "Failed to fetch settings");
  },

  update: async (data: Record<string, unknown>): Promise<void> => {
    const res = await fetchWithAuth(`${API_BASE}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    await parseApiResponse<{ success: boolean }>(res, "Failed to update settings");
  },
};

// Export API_URL for other uses
export { API_URL };
