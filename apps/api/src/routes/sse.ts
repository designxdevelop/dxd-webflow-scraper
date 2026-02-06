import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../env.js";

const app = new Hono<AppEnv>();

// SSE endpoint for live crawl logs.
// Uses the PubSubClient abstraction:
// - Node: ioredis pub/sub (persistent connection)
// - Workers: polls Redis stream via Upstash HTTP
app.get("/crawls/:id", async (c) => {
  const crawlId = c.req.param("id");
  const channel = `crawl:${crawlId}`;
  const pubsub = c.get("pubsub");

  return streamSSE(c, async (stream) => {
    const unsubscribe = await pubsub.subscribe(channel, async (message) => {
      try {
        await stream.writeSSE({
          data: message,
          event: "message",
        });
      } catch {
        // Stream closed
      }
    });

    try {
      // Send initial ping
      await stream.writeSSE({
        data: JSON.stringify({ type: "connected", crawlId }),
        event: "message",
      });

      // Keep-alive ping every 30 seconds
      const keepAlive = setInterval(async () => {
        try {
          await stream.writeSSE({
            data: JSON.stringify({ type: "ping" }),
            event: "ping",
          });
        } catch {
          clearInterval(keepAlive);
        }
      }, 30000);

      // Wait for stream to close
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(keepAlive);
          resolve();
        });
      });
    } finally {
      await unsubscribe();
    }
  });
});

export const sseRoutes = app;
