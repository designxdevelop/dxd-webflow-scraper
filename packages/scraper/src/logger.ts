import type { LogLevel } from "./types.js";

export type LogCallback = (level: LogLevel, message: string, url?: string) => void | Promise<void>;

let logCallback: LogCallback | null = null;

export function setLogCallback(callback: LogCallback | null): void {
  logCallback = callback;
}

export const log = {
  debug: (message: string, url?: string) => {
    if (logCallback) {
      logCallback("debug", message, url);
    } else if (process.env.DEBUG_ASSET_REWRITE === "1") {
      console.log("[debug]", message);
    }
  },
  info: (message: string, url?: string) => {
    if (logCallback) {
      logCallback("info", message, url);
    } else {
      console.log("[info]", message);
    }
  },
  warn: (message: string, url?: string) => {
    if (logCallback) {
      logCallback("warn", message, url);
    } else {
      console.warn("[warn]", message);
    }
  },
  error: (message: string, url?: string) => {
    if (logCallback) {
      logCallback("error", message, url);
    } else {
      console.error("[error]", message);
    }
  },
};
