import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { subClient } from "../queue/client.js";
import Redis from "ioredis";

const app = new Hono();

// SSE endpoint for live crawl logs
app.get("/crawls/:id", async (c) => {
  const crawlId = c.req.param("id");
  const channel = `crawl:${crawlId}`;

  return streamSSE(c, async (stream) => {
    // Create a dedicated subscriber for this connection
    const subscriber = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

    try {
      await subscriber.subscribe(channel);

      // Set up message handler
      subscriber.on("message", async (ch, message) => {
        if (ch === channel) {
          try {
            await stream.writeSSE({
              data: message,
              event: "message",
            });
          } catch (error) {
            // Stream closed, will be handled by cleanup
          }
        }
      });

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
      // Cleanup
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    }
  });
});

export const sseRoutes = app;
