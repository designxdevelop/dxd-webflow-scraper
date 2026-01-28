import path from "node:path";
import fs from "fs-extra";
import { CrawlState } from "./types.js";
import { log } from "./logger.js";

const DEFAULT_STATE_FILE = ".crawl-state.json";

export function getStateFilePath(outputDir: string, customPath?: string): string {
  if (customPath) {
    return path.isAbsolute(customPath) ? customPath : path.resolve(process.cwd(), customPath);
  }
  return path.join(outputDir, DEFAULT_STATE_FILE);
}

export async function loadState(statePath: string): Promise<CrawlState | null> {
  try {
    if (await fs.pathExists(statePath)) {
      const data = await fs.readJson(statePath);
      log.info(`Loaded state from ${statePath}: ${data.succeeded.length} succeeded, ${data.failed.length} failed`);
      return data as CrawlState;
    }
  } catch (error) {
    log.warn(`Failed to load state from ${statePath}: ${(error as Error).message}`);
  }
  return null;
}

export async function saveState(statePath: string, state: CrawlState): Promise<void> {
  try {
    state.lastUpdated = Date.now();
    await fs.writeJson(statePath, state, { spaces: 2 });
  } catch (error) {
    log.warn(`Failed to save state to ${statePath}: ${(error as Error).message}`);
  }
}

export async function updateStateProgress(
  statePath: string,
  state: CrawlState,
  succeeded: string[],
  failed: string[]
): Promise<void> {
  state.succeeded = [...new Set([...state.succeeded, ...succeeded])];
  state.failed = [...new Set([...state.failed, ...failed])];
  // Remove succeeded URLs from failed list if they're now successful
  state.failed = state.failed.filter((url) => !state.succeeded.includes(url));
  await saveState(statePath, state);
}

export function filterUrlsForResume(
  urls: string[],
  state: CrawlState | null,
  resume: boolean,
  retryFailed: boolean
): string[] {
  if (!state) {
    return urls;
  }

  if (retryFailed) {
    return state.failed;
  }

  if (resume) {
    // Skip URLs that already succeeded
    return urls.filter((url) => !state.succeeded.includes(url));
  }

  return urls;
}
