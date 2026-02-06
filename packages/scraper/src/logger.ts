import type { LogLevel } from "./types.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type LogCallback = (level: LogLevel, message: string, url?: string) => void | Promise<void>;

const logCallbackStorage = new AsyncLocalStorage<LogCallback | null>();
let fallbackLogCallback: LogCallback | null = null;

export function setLogCallback(callback: LogCallback | null): void {
  fallbackLogCallback = callback;
}

export function runWithLogCallback<T>(callback: LogCallback | null, fn: () => Promise<T>): Promise<T> {
  return logCallbackStorage.run(callback, fn);
}

function getLogCallback(): LogCallback | null {
  const scoped = logCallbackStorage.getStore();
  return scoped === undefined ? fallbackLogCallback : scoped;
}

export const log = {
  debug: (message: string, url?: string) => {
    const callback = getLogCallback();
    if (callback) {
      callback("debug", message, url);
    } else if (process.env.DEBUG_ASSET_REWRITE === "1") {
      console.log("[debug]", message);
    }
  },
  info: (message: string, url?: string) => {
    const callback = getLogCallback();
    if (callback) {
      callback("info", message, url);
    } else {
      console.log("[info]", message);
    }
  },
  warn: (message: string, url?: string) => {
    const callback = getLogCallback();
    if (callback) {
      callback("warn", message, url);
    } else {
      console.warn("[warn]", message);
    }
  },
  error: (message: string, url?: string) => {
    const callback = getLogCallback();
    if (callback) {
      callback("error", message, url);
    } else {
      console.error("[error]", message);
    }
  },
};
