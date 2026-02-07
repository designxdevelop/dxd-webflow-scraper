import { useState, useEffect } from "react";
import { API_URL } from "../api";

export interface CrawlLogEvent {
  level: string;
  message: string;
  url?: string;
  timestamp: string;
}

export interface CrawlProgressEvent {
  total: number;
  succeeded: number;
  failed: number;
  currentUrl?: string;
}

export interface UseCrawlLogsResult {
  logs: CrawlLogEvent[];
  progress: CrawlProgressEvent | null;
  connected: boolean;
  error: Error | null;
}

export function useCrawlLogs(crawlId: string | null): UseCrawlLogsResult {
  const [logs, setLogs] = useState<CrawlLogEvent[]>([]);
  const [progress, setProgress] = useState<CrawlProgressEvent | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!crawlId) {
      setLogs([]);
      setProgress(null);
      setConnected(false);
      setError(null);
      return;
    }

    // Ensure we don't carry over logs/progress from a previous crawl.
    setLogs([]);
    setProgress(null);
    setConnected(false);
    setError(null);

    let isClosed = false;
    const eventSource = new EventSource(`${API_URL}/api/sse/crawls/${crawlId}`, {
      withCredentials: true,
    });

    eventSource.onopen = () => {
      if (isClosed) return;
      setConnected(true);
      setError(null);
    };

    eventSource.onmessage = (event) => {
      if (isClosed) return;
      try {
        const data = JSON.parse(event.data);

        if (data.type === "log") {
          setLogs((prev) => [
            ...prev,
            {
              level: data.level,
              message: data.message,
              url: data.url,
              timestamp: data.timestamp || new Date().toISOString(),
            },
          ]);
        } else if (data.type === "progress") {
          setProgress({
            total: data.total,
            succeeded: data.succeeded,
            failed: data.failed,
            currentUrl: data.currentUrl,
          });
        } else if (data.type === "connected") {
          // Connection confirmed
        } else if (data.type === "ping") {
          // Keep-alive, ignore
        }
      } catch (e) {
        console.error("Failed to parse SSE message:", e);
      }
    };

    eventSource.onerror = () => {
      if (isClosed) return;
      setConnected(false);
      setError(new Error("Connection lost"));
      // Let EventSource retry automatically. Closing here prevents reconnection
      // and can leave the UI stuck in "Connecting..." for active crawls.
    };

    return () => {
      isClosed = true;
      eventSource.close();
      setConnected(false);
    };
  }, [crawlId]);

  return { logs, progress, connected, error };
}
