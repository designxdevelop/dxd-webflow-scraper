import { Queue } from "bullmq";
import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const crawlQueue = new Queue("crawl-jobs", {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 100,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  },
});

// For pub/sub (SSE)
export const pubClient = new Redis(redisUrl);
export const subClient = new Redis(redisUrl);

export async function publishCrawlEvent(crawlId: string, event: object) {
  await pubClient.publish(`crawl:${crawlId}`, JSON.stringify(event));
}
