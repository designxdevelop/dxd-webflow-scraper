import path from "node:path";
import fs from "fs-extra";
import { log } from "./logger.js";

interface RedirectHas {
  type: "query";
  key: string;
  value?: string;
}

interface RedirectRule {
  source: string;
  destination: string;
  permanent: boolean;
  has?: RedirectHas[];
}

interface OutputConfig {
  cleanUrls?: boolean;
  trailingSlash?: boolean;
  redirects?: RedirectRule[];
}

const DEFAULT_CONFIG: OutputConfig = {
  cleanUrls: true,
  trailingSlash: false,
};

export async function writeOutputConfig(
  outputDir: string,
  redirectsCsv?: string,
  filename: string = "vercel.json"
): Promise<void> {
  const filePath = path.join(outputDir, filename);
  const redirects = redirectsCsv ? await loadRedirects(redirectsCsv) : [];
  const config = redirects.length ? { ...DEFAULT_CONFIG, redirects } : DEFAULT_CONFIG;
  await fs.writeJson(filePath, config, { spaces: 2 });
}

async function loadRedirects(csvPath: string): Promise<RedirectRule[]> {
  try {
    if (!(await fs.pathExists(csvPath))) {
      log.warn(`Redirects CSV not found at ${csvPath}. Skipping redirects.`);
      return [];
    }

    const raw = await fs.readFile(csvPath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      return [];
    }

    const startIndex = isHeaderRow(lines[0]) ? 1 : 0;
    const redirects: RedirectRule[] = [];

    for (const line of lines.slice(startIndex)) {
      const redirect = parseRedirectLine(line);
      if (redirect) {
        redirects.push(redirect);
      }
    }

    return redirects;
  } catch (error) {
    log.warn(`Failed to parse redirects CSV at ${csvPath}: ${(error as Error).message}`);
    return [];
  }
}

function isHeaderRow(line: string): boolean {
  const normalized = line.toLowerCase();
  return normalized.startsWith("source,") || normalized === "source,target";
}

function parseRedirectLine(line: string): RedirectRule | null {
  const commaIndex = line.indexOf(",");
  if (commaIndex === -1) return null;

  const sourceRaw = line.slice(0, commaIndex).trim();
  const destinationRaw = line.slice(commaIndex + 1).trim();

  if (!sourceRaw || !destinationRaw) return null;

  const { source, has } = normalizeSourcePattern(sourceRaw);
  const destination = normalizeDestination(destinationRaw);

  return {
    source,
    destination,
    permanent: false,
    ...(has ? { has } : {}),
  };
}

function normalizeSourcePattern(value: string): { source: string; has?: RedirectHas[] } {
  const unescaped = value.replace(/%([?&_=])/g, "$1").trim();
  const [pathPart, queryPart] = unescaped.split("?", 2);
  const source = normalizePathPattern(pathPart);
  const has = queryPart ? buildQueryHas(queryPart) : undefined;

  return { source, ...(has && has.length ? { has } : {}) };
}

function normalizePathPattern(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("/")) return trimmed;
  return `/${trimmed}`;
}

function buildQueryHas(query: string): RedirectHas[] {
  const parts = query
    .split("&")
    .map((part) => part.trim())
    .filter(Boolean);
  const has: RedirectHas[] = [];

  for (const part of parts) {
    const [rawKey, rawValue] = part.split("=", 2);
    const key = rawKey?.trim();
    const value = rawValue?.trim();
    if (!key) {
      continue;
    }

    has.push({
      type: "query",
      key,
      ...(value ? { value } : {}),
    });
  }

  return has;
}

function normalizeDestination(value: string): string {
  const replaced = value.replace(/%(\d+)/g, "$$$1");
  if (replaced.startsWith("http://") || replaced.startsWith("https://")) {
    return replaced;
  }
  if (replaced.startsWith("/")) {
    return replaced;
  }
  return `/${replaced}`;
}
