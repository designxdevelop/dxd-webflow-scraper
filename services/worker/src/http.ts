import { Hono } from "hono";
import { Queue } from "bullmq";
import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const apiSecret = process.env.WORKER_API_SECRET || "";

const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const crawlQueue = new Queue("crawl-jobs", {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 100,
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  },
});

const app = new Hono();

// Auth middleware — verify shared secret
app.use("*", async (c, next) => {
  if (!apiSecret) {
    // No secret configured — skip auth (dev mode)
    return next();
  }

  const auth = c.req.header("Authorization");
  if (auth !== `Bearer ${apiSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
});

// Enqueue a crawl job
app.post("/enqueue", async (c) => {
  const body = await c.req.json<{ siteId: string; crawlId: string }>();

  if (!body.siteId || !body.crawlId) {
    return c.json({ error: "siteId and crawlId are required" }, 400);
  }

  await crawlQueue.add("crawl", { siteId: body.siteId, crawlId: body.crawlId }, { jobId: body.crawlId });

  return c.json({ ok: true, jobId: body.crawlId });
});

// Cancel a crawl job (remove from queue if pending)
app.post("/cancel", async (c) => {
  const body = await c.req.json<{ crawlId: string }>();

  if (!body.crawlId) {
    return c.json({ error: "crawlId is required" }, 400);
  }

  try {
    await crawlQueue.remove(body.crawlId);
  } catch {
    // Job may not exist or already processing — that's fine
  }

  return c.json({ ok: true });
});

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

export { app as httpApp };

export function startHttpServer(port: number = 3002) {
  const server = Bun.serve({
    port,
    fetch: app.fetch,
  });
  console.log(`[Worker] HTTP API server running on port ${port}`);
  return server;
}
