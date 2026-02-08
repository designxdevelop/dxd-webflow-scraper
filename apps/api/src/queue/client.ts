import { Queue } from "bullmq";
import Redis from "ioredis";

// ---------------------------------------------------------------------------
// Queue abstraction: supports both BullMQ (Node) and HTTP (Workers) backends
// ---------------------------------------------------------------------------

export interface QueueClient {
  addCrawlJob(siteId: string, crawlId: string): Promise<void>;
  removeCrawlJob(crawlId: string): Promise<void>;
}

export interface PubSubClient {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>>;
}

// ---------------------------------------------------------------------------
// BullMQ / ioredis implementation (Node.js runtime)
// ---------------------------------------------------------------------------

export function createNodeQueueClient(redisUrl: string): QueueClient {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("crawl-jobs", {
    connection: redis,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 100,
      attempts: 1,
    },
  });

  return {
    async addCrawlJob(siteId, crawlId) {
      await queue.add("crawl", { siteId, crawlId }, { jobId: crawlId });
    },
    async removeCrawlJob(crawlId) {
      try {
        await queue.remove(crawlId);
      } catch {
        // Job may not exist
      }
    },
  };
}

export function createNodePubSubClient(redisUrl: string): PubSubClient {
  const pubClient = new Redis(redisUrl);

  return {
    async publish(channel, message) {
      await pubClient.publish(channel, message);
    },
    async subscribe(channel, onMessage) {
      const subscriber = new Redis(redisUrl);
      await subscriber.subscribe(channel);
      subscriber.on("message", (ch, msg) => {
        if (ch === channel) onMessage(msg);
      });
      return async () => {
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
      };
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP implementation (Workers runtime — calls worker service via HTTP)
// ---------------------------------------------------------------------------

export function createHttpQueueClient(workerServiceUrl: string, apiSecret: string): QueueClient {
  const baseUrl = workerServiceUrl.replace(/\/+$/, "");

  return {
    async addCrawlJob(siteId, crawlId) {
      const res = await fetch(`${baseUrl}/enqueue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiSecret}`,
        },
        body: JSON.stringify({ siteId, crawlId }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to enqueue crawl job: ${res.status} ${text}`);
      }
    },
    async removeCrawlJob(crawlId) {
      const res = await fetch(`${baseUrl}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiSecret}`,
        },
        body: JSON.stringify({ crawlId }),
      });
      if (!res.ok) {
        // Non-critical — the worker checks DB status for cancellation anyway
      }
    },
  };
}

export function createHttpPubSubClient(
  upstashUrl: string,
  upstashToken: string
): PubSubClient {
  const baseUrl = upstashUrl.replace(/\/+$/, "");

  async function redisCommand(command: string[]): Promise<unknown> {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${upstashToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) {
      throw new Error(`Upstash Redis error: ${res.status}`);
    }
    const data = (await res.json()) as { result: unknown };
    return data.result;
  }

  return {
    async publish(channel, message) {
      await redisCommand(["PUBLISH", channel, message]);
    },
    async subscribe(channel, onMessage) {
      // Workers can't hold persistent Redis pub/sub sockets.
      // Poll Redis Streams via Upstash HTTP instead.
      const crawlId = channel.replace(/^crawl:/, "");
      const streamKey = `crawl-events:${crawlId}`;
      let lastId = "$";
      let stopped = false;

      const parseStreamResult = (result: unknown): string[] => {
        const messages: string[] = [];
        if (!Array.isArray(result)) return messages;

        for (const streamEntry of result) {
          if (!Array.isArray(streamEntry) || streamEntry.length < 2) continue;
          const entries = streamEntry[1];
          if (!Array.isArray(entries)) continue;

          for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length < 2) continue;
            const id = entry[0];
            const fields = entry[1];
            if (typeof id === "string") {
              lastId = id;
            }

            if (Array.isArray(fields)) {
              for (let i = 0; i < fields.length - 1; i += 2) {
                const key = fields[i];
                const value = fields[i + 1];
                if (key === "data" && typeof value === "string") {
                  messages.push(value);
                }
              }
            }
          }
        }

        return messages;
      };

      const tick = async () => {
        if (stopped) return;
        try {
          const result = await redisCommand([
            "XREAD",
            "COUNT",
            "100",
            "STREAMS",
            streamKey,
            lastId,
          ]);
          const messages = parseStreamResult(result);
          for (const message of messages) {
            onMessage(message);
          }
        } catch {
          // Ignore transient polling errors; next tick will retry.
        }
      };

      const interval = setInterval(tick, 1500);
      void tick();

      return async () => {
        stopped = true;
        clearInterval(interval);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy exports for backward compatibility during migration.
// Routes that haven't been refactored can still import these.
// ---------------------------------------------------------------------------

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

let _legacyQueueClient: QueueClient | null = null;
/** @deprecated Use c.get("queue") from Hono context. */
export function getLegacyQueueClient(): QueueClient {
  if (!_legacyQueueClient) {
    _legacyQueueClient = createNodeQueueClient(redisUrl);
  }
  return _legacyQueueClient;
}

let _legacyPubSub: PubSubClient | null = null;
/** @deprecated Use c.get("pubsub") from Hono context. */
export function getLegacyPubSubClient(): PubSubClient {
  if (!_legacyPubSub) {
    _legacyPubSub = createNodePubSubClient(redisUrl);
  }
  return _legacyPubSub;
}

// Re-export for any imports that used the old named exports
/** @deprecated */
export const crawlQueue = new Proxy({} as QueueClient, {
  get(_target, prop, receiver) {
    const client = getLegacyQueueClient();
    return Reflect.get(client, prop, receiver);
  },
});

/** @deprecated */
export async function publishCrawlEvent(crawlId: string, event: object) {
  const client = getLegacyPubSubClient();
  await client.publish(`crawl:${crawlId}`, JSON.stringify(event));
}
