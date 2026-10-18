import { getContainer } from "@cloudflare/containers";
import type { Crawler } from "../crawler.js";

// Postgres rows (status = 'pending') are the queue. Enqueueing = waking the crawler container.
export interface QueueClient {
  addCrawlJob(siteId: string, crawlId: string): Promise<void>;
  addPublicationJob(siteId: string, crawlId: string, publicationId: string, activate: boolean, autoPublish?: boolean): Promise<void>;
}

export function createContainerQueueClient(crawler: DurableObjectNamespace<Crawler>): QueueClient {
  const stub = () => getContainer(crawler);
  return {
    async addCrawlJob(_siteId, crawlId) {
      await stub().kick(crawlId);
    },
    async addPublicationJob() {
      await stub().kick();
    },
  };
}
