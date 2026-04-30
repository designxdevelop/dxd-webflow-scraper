import { Queue } from "bullmq";
import Redis from "ioredis";

// ---------------------------------------------------------------------------
// Queue abstraction
// ---------------------------------------------------------------------------

export interface QueueClient {
  addCrawlJob(siteId: string, crawlId: string): Promise<void>;
  addPublicationJob(siteId: string, crawlId: string, publicationId: string, activate: boolean, autoPublish?: boolean): Promise<void>;
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
    async addPublicationJob(siteId, crawlId, publicationId, activate, autoPublish) {
      const publishQueue = new Queue("publication-jobs", {
        connection: redis,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 100,
          attempts: 1,
        },
      });
      await publishQueue.add("publish", { siteId, crawlId, publicationId, activate, autoPublish: autoPublish ?? false }, { jobId: publicationId });
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
