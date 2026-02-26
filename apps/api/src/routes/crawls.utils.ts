const DOWNLOAD_FAILURE_PATTERN = /(?:Could not|Failed to)\s+download\s+(https?:\/\/\S+)/i;
const TRAILING_URL_PUNCTUATION = /[),.;:]+$/;

function sanitizeFailedUrlCandidate(raw: string): string {
  return raw.trim().replace(TRAILING_URL_PUNCTUATION, "");
}

export function normalizeUrlForBlacklist(raw: string): string | null {
  try {
    const parsed = new URL(sanitizeFailedUrlCandidate(raw));
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function extractFailedDownloadUrl(log: { message: string; url?: string | null }): string | null {
  if (log.url) {
    return normalizeUrlForBlacklist(log.url);
  }

  const match = DOWNLOAD_FAILURE_PATTERN.exec(log.message);
  if (!match) {
    return null;
  }

  const raw = sanitizeFailedUrlCandidate(match[1]);
  return normalizeUrlForBlacklist(raw);
}
