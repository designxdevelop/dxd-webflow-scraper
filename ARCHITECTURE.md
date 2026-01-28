# DXD Webflow Scraper - Architecture Design

## Executive Summary

This document outlines the architecture for **dxd-webflow-scraper**, a web application that provides a UI dashboard for managing and executing Webflow site scraping jobs. It builds upon the proven crawling logic from pdc-scraper while adding multi-site management, job scheduling, real-time progress tracking, and flexible storage options.

---

## 1. Project Structure

```
dxd-webflow-scraper/
├── apps/
│   └── web/                          # Next.js application
│       ├── app/                      # App Router pages
│       │   ├── (dashboard)/          # Dashboard layout group
│       │   │   ├── page.tsx          # Home/overview
│       │   │   ├── sites/
│       │   │   │   ├── page.tsx      # Sites list
│       │   │   │   ├── new/page.tsx  # Add new site
│       │   │   │   └── [siteId]/
│       │   │   │       ├── page.tsx  # Site details
│       │   │   │       └── crawls/
│       │   │   │           └── [crawlId]/page.tsx  # Crawl details
│       │   │   ├── crawls/
│       │   │   │   └── page.tsx      # All crawls list
│       │   │   └── settings/
│       │   │       └── page.tsx      # Global settings
│       │   ├── api/                  # API routes
│       │   │   ├── sites/
│       │   │   │   ├── route.ts      # GET/POST sites
│       │   │   │   └── [siteId]/
│       │   │   │       ├── route.ts  # GET/PATCH/DELETE site
│       │   │   │       └── crawls/
│       │   │   │           └── route.ts  # POST start crawl
│       │   │   ├── crawls/
│       │   │   │   ├── route.ts      # GET all crawls
│       │   │   │   └── [crawlId]/
│       │   │   │       ├── route.ts  # GET/PATCH crawl
│       │   │   │       ├── cancel/route.ts
│       │   │   │       ├── download/route.ts
│       │   │   │       └── logs/route.ts  # SSE endpoint
│       │   │   ├── schedules/
│       │   │   │   └── route.ts
│       │   │   └── settings/
│       │   │       └── route.ts
│       │   ├── preview/              # Static file preview
│       │   │   └── [...path]/route.ts
│       │   └── layout.tsx
│       ├── components/
│       │   ├── ui/                   # Shared UI components
│       │   ├── sites/                # Site-specific components
│       │   ├── crawls/               # Crawl-specific components
│       │   └── dashboard/            # Dashboard layout components
│       ├── lib/
│       │   ├── db/
│       │   │   ├── client.ts         # Drizzle client
│       │   │   ├── schema.ts         # Database schema
│       │   │   └── migrations/       # Database migrations
│       │   ├── storage/
│       │   │   ├── index.ts          # Storage abstraction
│       │   │   ├── local.ts          # Local filesystem
│       │   │   └── s3.ts             # S3/R2 compatible
│       │   ├── queue/
│       │   │   ├── client.ts         # Queue client
│       │   │   └── types.ts          # Job types
│       │   └── utils/
│       ├── hooks/                    # React hooks
│       └── types/                    # TypeScript types
│
├── packages/
│   └── scraper/                      # Core scraping logic (extracted from pdc-scraper)
│       ├── src/
│       │   ├── index.ts              # Main exports
│       │   ├── crawler.ts            # Crawl orchestration
│       │   ├── page-processor.ts     # Page processing
│       │   ├── asset-downloader.ts   # Asset handling
│       │   ├── url-rewriter.ts       # HTML rewriting
│       │   ├── sitemap-parser.ts     # Sitemap discovery
│       │   ├── storage-adapter.ts    # Storage interface for scraper
│       │   └── types.ts              # Scraper types
│       ├── package.json
│       └── tsconfig.json
│
├── services/
│   └── worker/                       # Background worker process
│       ├── src/
│       │   ├── index.ts              # Worker entry point
│       │   ├── handlers/
│       │   │   ├── crawl.ts          # Crawl job handler
│       │   │   └── archive.ts        # Archive generation handler
│       │   ├── scheduler.ts          # Cron scheduler
│       │   └── progress-reporter.ts  # Progress updates
│       ├── package.json
│       └── Dockerfile
│
├── docker-compose.yml                # Local development
├── package.json                      # Root package.json (workspaces)
├── turbo.json                        # Turborepo config
├── tsconfig.base.json                # Shared TS config
└── .env.example
```

---

## 2. Database Schema

Using **Drizzle ORM** with PostgreSQL:

```typescript
// packages/db/schema.ts

import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core';

// Enums
export const crawlStatusEnum = pgEnum('crawl_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
]);

export const storageTypeEnum = pgEnum('storage_type', [
  'local',
  's3'
]);

export const scheduleFrequencyEnum = pgEnum('schedule_frequency', [
  'manual',
  'hourly',
  'daily',
  'weekly',
  'monthly'
]);

// Sites table - stores Webflow site configurations
export const sites = pgTable('sites', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),                    // Display name
  baseUrl: text('base_url').notNull().unique(),   // Webflow site URL
  description: text('description'),
  
  // Site-specific configuration
  config: jsonb('config').$type<SiteConfig>().default({
    concurrency: 5,
    maxPages: null,
    excludePatterns: [],
    includePatterns: [],
    removeWebflowBadge: true,
    downloadExternalAssets: false,
  }),
  
  // Schedule configuration
  scheduleFrequency: scheduleFrequencyEnum('schedule_frequency').default('manual'),
  scheduleCron: text('schedule_cron'),            // Custom cron expression
  scheduleEnabled: boolean('schedule_enabled').default(false),
  lastScheduledAt: timestamp('last_scheduled_at'),
  nextScheduledAt: timestamp('next_scheduled_at'),
  
  // Metadata
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Crawls table - stores crawl job history
export const crawls = pgTable('crawls', {
  id: uuid('id').defaultRandom().primaryKey(),
  siteId: uuid('site_id').references(() => sites.id, { onDelete: 'cascade' }).notNull(),
  
  status: crawlStatusEnum('status').default('pending').notNull(),
  
  // Progress tracking
  totalPages: integer('total_pages'),
  processedPages: integer('processed_pages').default(0),
  succeededPages: integer('succeeded_pages').default(0),
  failedPages: integer('failed_pages').default(0),
  
  // Timing
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  durationMs: integer('duration_ms'),
  
  // Configuration snapshot (captured at crawl start)
  configSnapshot: jsonb('config_snapshot').$type<SiteConfig>(),
  
  // Storage location
  storageType: storageTypeEnum('storage_type').notNull(),
  storagePath: text('storage_path'),              // Local path or S3 key prefix
  archivePath: text('archive_path'),              // Path to zip archive (if generated)
  archiveSize: integer('archive_size'),           // Archive size in bytes
  
  // Error tracking
  errorMessage: text('error_message'),
  failedUrls: jsonb('failed_urls').$type<string[]>().default([]),
  
  // Trigger info
  triggeredBy: text('triggered_by').default('manual'),  // 'manual', 'schedule', 'api'
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Crawl logs table - stores detailed crawl progress logs
export const crawlLogs = pgTable('crawl_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  crawlId: uuid('crawl_id').references(() => crawls.id, { onDelete: 'cascade' }).notNull(),
  
  level: text('level').notNull(),                 // 'info', 'warn', 'error', 'debug'
  message: text('message').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  
  timestamp: timestamp('timestamp').defaultNow().notNull(),
});

// Global settings table
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Types
interface SiteConfig {
  concurrency: number;
  maxPages: number | null;
  excludePatterns: string[];          // URL patterns to exclude
  includePatterns: string[];          // URL patterns to include (if empty, include all)
  removeWebflowBadge: boolean;
  downloadExternalAssets: boolean;    // Download assets from external CDNs
  customHeaders?: Record<string, string>;
  timeout?: number;                   // Page navigation timeout
}
```

### Database Indexes

```typescript
// Add indexes for common queries
import { index } from 'drizzle-orm/pg-core';

// On sites table
export const sitesBaseUrlIdx = index('sites_base_url_idx').on(sites.baseUrl);
export const sitesNextScheduledIdx = index('sites_next_scheduled_idx').on(sites.nextScheduledAt);

// On crawls table
export const crawlsSiteIdIdx = index('crawls_site_id_idx').on(crawls.siteId);
export const crawlsStatusIdx = index('crawls_status_idx').on(crawls.status);
export const crawlsCreatedAtIdx = index('crawls_created_at_idx').on(crawls.createdAt);

// On crawl_logs table
export const crawlLogsCrawlIdIdx = index('crawl_logs_crawl_id_idx').on(crawlLogs.crawlId);
export const crawlLogsTimestampIdx = index('crawl_logs_timestamp_idx').on(crawlLogs.timestamp);
```

---

## 3. API Design

### Sites API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sites` | List all sites |
| POST | `/api/sites` | Create a new site |
| GET | `/api/sites/:siteId` | Get site details |
| PATCH | `/api/sites/:siteId` | Update site |
| DELETE | `/api/sites/:siteId` | Delete site |
| POST | `/api/sites/:siteId/crawls` | Start a new crawl |
| GET | `/api/sites/:siteId/crawls` | Get crawls for site |
| PATCH | `/api/sites/:siteId/schedule` | Update schedule |

### Crawls API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/crawls` | List all crawls (with filters) |
| GET | `/api/crawls/:crawlId` | Get crawl details |
| POST | `/api/crawls/:crawlId/cancel` | Cancel running crawl |
| GET | `/api/crawls/:crawlId/download` | Download archive |
| GET | `/api/crawls/:crawlId/logs` | SSE stream of logs |
| POST | `/api/crawls/:crawlId/retry` | Retry failed pages |

### Settings API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | Get global settings |
| PATCH | `/api/settings` | Update settings |

### Preview API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/preview/:crawlId/*` | Serve archived static files |

### Request/Response Examples

```typescript
// POST /api/sites
// Request
{
  "name": "My Webflow Site",
  "baseUrl": "https://example.webflow.io",
  "config": {
    "concurrency": 5,
    "maxPages": 100,
    "removeWebflowBadge": true
  }
}

// Response
{
  "id": "uuid",
  "name": "My Webflow Site",
  "baseUrl": "https://example.webflow.io",
  "config": { ... },
  "createdAt": "2024-01-01T00:00:00Z"
}

// POST /api/sites/:siteId/crawls
// Request
{
  "storageType": "local",  // or "s3"
  "configOverrides": {     // Optional overrides for this crawl
    "maxPages": 50
  }
}

// Response
{
  "id": "uuid",
  "siteId": "uuid",
  "status": "pending",
  "createdAt": "2024-01-01T00:00:00Z"
}

// GET /api/crawls/:crawlId/logs (SSE)
// Response stream
event: log
data: {"level":"info","message":"Starting crawl...","timestamp":"2024-01-01T00:00:00Z"}

event: progress
data: {"processedPages":5,"totalPages":100,"succeededPages":5,"failedPages":0}

event: complete
data: {"status":"completed","durationMs":120000}
```

---

## 4. Worker Architecture

### Overview

The worker runs as a separate process/container and handles:
1. **Crawl job execution** - Processing queued crawl jobs
2. **Schedule management** - Triggering scheduled crawls
3. **Archive generation** - Creating zip archives on demand

### Queue System

Using **BullMQ** with Redis for job queuing:

```typescript
// services/worker/src/queues.ts

import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';

const connection = new Redis(process.env.REDIS_URL);

// Crawl queue
export const crawlQueue = new Queue('crawl', { connection });

// Archive queue (lower priority)
export const archiveQueue = new Queue('archive', { connection });

// Job types
interface CrawlJobData {
  crawlId: string;
  siteId: string;
  baseUrl: string;
  config: SiteConfig;
  storageType: 'local' | 's3';
  storagePath: string;
}

interface ArchiveJobData {
  crawlId: string;
  sourcePath: string;
  outputPath: string;
}
```

### Crawl Worker

```typescript
// services/worker/src/handlers/crawl.ts

import { Worker, Job } from 'bullmq';
import { createScraper } from '@dxd/scraper';
import { db } from '../db';
import { broadcastProgress } from '../progress-reporter';

export const crawlWorker = new Worker('crawl', async (job: Job<CrawlJobData>) => {
  const { crawlId, siteId, baseUrl, config, storageType, storagePath } = job.data;
  
  // Update status to running
  await db.update(crawls)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(crawls.id, crawlId));
  
  // Create scraper instance with storage adapter
  const storage = createStorageAdapter(storageType, storagePath);
  const scraper = createScraper({
    baseUrl,
    config,
    storage,
    onProgress: async (progress) => {
      // Update database
      await db.update(crawls)
        .set({
          processedPages: progress.processed,
          succeededPages: progress.succeeded,
          failedPages: progress.failed,
          totalPages: progress.total,
        })
        .where(eq(crawls.id, crawlId));
      
      // Broadcast to SSE clients
      broadcastProgress(crawlId, progress);
    },
    onLog: async (level, message, metadata) => {
      // Store log
      await db.insert(crawlLogs).values({
        crawlId,
        level,
        message,
        metadata,
      });
      
      // Broadcast to SSE clients
      broadcastLog(crawlId, { level, message, metadata });
    },
  });
  
  try {
    const result = await scraper.run();
    
    await db.update(crawls)
      .set({
        status: 'completed',
        completedAt: new Date(),
        durationMs: result.durationMs,
        failedUrls: result.failedUrls,
      })
      .where(eq(crawls.id, crawlId));
      
  } catch (error) {
    await db.update(crawls)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage: error.message,
      })
      .where(eq(crawls.id, crawlId));
    throw error;
  }
}, { connection });
```

### Schedule Manager

```typescript
// services/worker/src/scheduler.ts

import cron from 'node-cron';
import { db } from './db';
import { crawlQueue } from './queues';

export function startScheduler() {
  // Check for due schedules every minute
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    
    // Find sites with due schedules
    const dueSites = await db.select()
      .from(sites)
      .where(
        and(
          eq(sites.scheduleEnabled, true),
          lte(sites.nextScheduledAt, now)
        )
      );
    
    for (const site of dueSites) {
      // Create crawl record
      const [crawl] = await db.insert(crawls)
        .values({
          siteId: site.id,
          status: 'pending',
          storageType: 'local', // Or from settings
          storagePath: generateStoragePath(site.id),
          configSnapshot: site.config,
          triggeredBy: 'schedule',
        })
        .returning();
      
      // Queue crawl job
      await crawlQueue.add('crawl', {
        crawlId: crawl.id,
        siteId: site.id,
        baseUrl: site.baseUrl,
        config: site.config,
        storageType: crawl.storageType,
        storagePath: crawl.storagePath,
      });
      
      // Update next scheduled time
      const nextScheduled = calculateNextSchedule(site.scheduleCron, site.scheduleFrequency);
      await db.update(sites)
        .set({
          lastScheduledAt: now,
          nextScheduledAt: nextScheduled,
        })
        .where(eq(sites.id, site.id));
    }
  });
}
```

---

## 5. Real-Time Progress Updates

### Architecture

Using **Server-Sent Events (SSE)** for real-time updates:

```
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│   Browser   │◄──────│  Next.js    │◄──────│   Worker    │
│  (SSE client)│ SSE  │  (SSE server)│ Redis │  (Publisher)│
└─────────────┘       └─────────────┘ PubSub└─────────────┘
```

### Implementation

```typescript
// apps/web/app/api/crawls/[crawlId]/logs/route.ts

import { NextRequest } from 'next/server';
import { Redis } from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

export async function GET(
  request: NextRequest,
  { params }: { params: { crawlId: string } }
) {
  const { crawlId } = params;
  
  // Create SSE stream
  const stream = new ReadableStream({
    start(controller) {
      const subscriber = new Redis(process.env.REDIS_URL);
      const channel = `crawl:${crawlId}`;
      
      subscriber.subscribe(channel, (err) => {
        if (err) {
          controller.error(err);
          return;
        }
      });
      
      subscriber.on('message', (ch, message) => {
        const data = JSON.parse(message);
        const event = `event: ${data.type}\ndata: ${JSON.stringify(data.payload)}\n\n`;
        controller.enqueue(new TextEncoder().encode(event));
        
        if (data.type === 'complete' || data.type === 'error') {
          subscriber.unsubscribe();
          subscriber.quit();
          controller.close();
        }
      });
      
      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        subscriber.unsubscribe();
        subscriber.quit();
      });
    },
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// services/worker/src/progress-reporter.ts

import { Redis } from 'ioredis';

const publisher = new Redis(process.env.REDIS_URL);

export function broadcastProgress(crawlId: string, progress: CrawlProgress) {
  publisher.publish(`crawl:${crawlId}`, JSON.stringify({
    type: 'progress',
    payload: progress,
  }));
}

export function broadcastLog(crawlId: string, log: CrawlLog) {
  publisher.publish(`crawl:${crawlId}`, JSON.stringify({
    type: 'log',
    payload: log,
  }));
}

export function broadcastComplete(crawlId: string, result: CrawlResult) {
  publisher.publish(`crawl:${crawlId}`, JSON.stringify({
    type: 'complete',
    payload: result,
  }));
}
```

### React Hook for SSE

```typescript
// apps/web/hooks/useCrawlProgress.ts

import { useEffect, useState, useCallback } from 'react';

interface CrawlProgress {
  processedPages: number;
  totalPages: number;
  succeededPages: number;
  failedPages: number;
}

interface CrawlLog {
  level: string;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export function useCrawlProgress(crawlId: string) {
  const [progress, setProgress] = useState<CrawlProgress | null>(null);
  const [logs, setLogs] = useState<CrawlLog[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'completed' | 'error'>('connecting');
  
  useEffect(() => {
    const eventSource = new EventSource(`/api/crawls/${crawlId}/logs`);
    
    eventSource.onopen = () => setStatus('connected');
    
    eventSource.addEventListener('progress', (event) => {
      setProgress(JSON.parse(event.data));
    });
    
    eventSource.addEventListener('log', (event) => {
      setLogs((prev) => [...prev, JSON.parse(event.data)]);
    });
    
    eventSource.addEventListener('complete', (event) => {
      setStatus('completed');
      eventSource.close();
    });
    
    eventSource.addEventListener('error', (event) => {
      setStatus('error');
      eventSource.close();
    });
    
    eventSource.onerror = () => {
      setStatus('error');
    };
    
    return () => eventSource.close();
  }, [crawlId]);
  
  return { progress, logs, status };
}
```

---

## 6. Storage Abstraction

### Interface

```typescript
// packages/scraper/src/storage-adapter.ts

export interface StorageAdapter {
  // Write operations
  writeFile(path: string, content: Buffer | string): Promise<void>;
  writeJson(path: string, data: unknown): Promise<void>;
  
  // Read operations
  readFile(path: string): Promise<Buffer>;
  readJson<T>(path: string): Promise<T>;
  exists(path: string): Promise<boolean>;
  
  // Directory operations
  ensureDir(path: string): Promise<void>;
  listFiles(path: string): Promise<string[]>;
  
  // Utility
  getPublicUrl(path: string): string;
  createReadStream(path: string): ReadableStream;
}

// apps/web/lib/storage/index.ts

import { LocalStorage } from './local';
import { S3Storage } from './s3';

export function createStorage(type: 'local' | 's3', config: StorageConfig): StorageAdapter {
  switch (type) {
    case 'local':
      return new LocalStorage(config.basePath);
    case 's3':
      return new S3Storage({
        bucket: config.bucket,
        region: config.region,
        endpoint: config.endpoint,  // For R2 compatibility
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      });
    default:
      throw new Error(`Unknown storage type: ${type}`);
  }
}
```

### Local Storage Implementation

```typescript
// apps/web/lib/storage/local.ts

import fs from 'fs-extra';
import path from 'path';

export class LocalStorage implements StorageAdapter {
  constructor(private basePath: string) {}
  
  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content);
  }
  
  async readFile(filePath: string): Promise<Buffer> {
    return fs.readFile(path.join(this.basePath, filePath));
  }
  
  getPublicUrl(filePath: string): string {
    // For local preview, serve through API route
    return `/preview/${filePath}`;
  }
  
  createReadStream(filePath: string): ReadableStream {
    const nodeStream = fs.createReadStream(path.join(this.basePath, filePath));
    return Readable.toWeb(nodeStream);
  }
  
  // ... other methods
}
```

### S3/R2 Storage Implementation

```typescript
// apps/web/lib/storage/s3.ts

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class S3Storage implements StorageAdapter {
  private client: S3Client;
  
  constructor(private config: S3Config) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }
  
  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: filePath,
      Body: typeof content === 'string' ? Buffer.from(content) : content,
    }));
  }
  
  getPublicUrl(filePath: string): string {
    // Generate presigned URL or use public bucket URL
    if (this.config.publicUrl) {
      return `${this.config.publicUrl}/${filePath}`;
    }
    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${filePath}`;
  }
  
  // ... other methods
}
```

---

## 7. Configuration Management

### Site-Specific vs Global Settings

| Setting | Scope | Description |
|---------|-------|-------------|
| `concurrency` | Site | Concurrent page processing |
| `maxPages` | Site | Max pages to crawl |
| `excludePatterns` | Site | URL patterns to skip |
| `includePatterns` | Site | URL patterns to include |
| `removeWebflowBadge` | Site | Remove Webflow branding |
| `downloadExternalAssets` | Site | Download third-party assets |
| `timeout` | Site | Navigation timeout |
| `defaultStorageType` | Global | Default storage backend |
| `s3Config` | Global | S3/R2 credentials |
| `localStoragePath` | Global | Local storage base path |
| `maxConcurrentCrawls` | Global | Limit simultaneous crawls |
| `logRetentionDays` | Global | How long to keep logs |
| `archiveRetentionDays` | Global | How long to keep archives |

### Global Settings Schema

```typescript
// Global settings stored in database
interface GlobalSettings {
  storage: {
    defaultType: 'local' | 's3';
    local: {
      basePath: string;
    };
    s3: {
      bucket: string;
      region: string;
      endpoint?: string;  // For R2
      accessKeyId: string;
      secretAccessKey: string;
      publicUrl?: string;
    };
  };
  crawl: {
    maxConcurrentCrawls: number;
    defaultConcurrency: number;
    defaultTimeout: number;
  };
  retention: {
    logDays: number;
    archiveDays: number;
  };
}
```

---

## 8. Key Implementation Considerations

### 8.1 Scraper Package Modifications

The core scraper logic from pdc-scraper needs these changes:

1. **Storage Abstraction**: Replace direct `fs` calls with `StorageAdapter` interface
2. **Progress Callbacks**: Add hooks for progress reporting
3. **Cancellation Support**: Add AbortController support for job cancellation
4. **Remove Vercel-specific Code**: Make output format generic (remove vercel.json generation)
5. **Configurable Asset Handling**: Make blocked domains configurable
6. **Remove Hardcoded Values**: Remove Point.com references

```typescript
// packages/scraper/src/crawler.ts

export interface ScraperOptions {
  baseUrl: string;
  config: SiteConfig;
  storage: StorageAdapter;
  signal?: AbortSignal;
  onProgress?: (progress: CrawlProgress) => void;
  onLog?: (level: string, message: string, metadata?: Record<string, unknown>) => void;
}

export async function crawlSite(options: ScraperOptions): Promise<CrawlResult> {
  const { baseUrl, config, storage, signal, onProgress, onLog } = options;
  
  // Check for cancellation before each major step
  if (signal?.aborted) {
    throw new Error('Crawl cancelled');
  }
  
  // Use storage adapter instead of fs
  await storage.ensureDir('css');
  await storage.ensureDir('js');
  // ...
  
  // Report progress
  onProgress?.({ processed: 0, total: urls.length, succeeded: 0, failed: 0 });
  
  // ... crawl logic
}
```

### 8.2 Archive Generation

```typescript
// services/worker/src/handlers/archive.ts

import archiver from 'archiver';

export async function generateArchive(
  storage: StorageAdapter,
  sourcePath: string,
  outputPath: string
): Promise<{ size: number }> {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const files = await storage.listFiles(sourcePath);
  
  for (const file of files) {
    const content = await storage.readFile(`${sourcePath}/${file}`);
    archive.append(content, { name: file });
  }
  
  await archive.finalize();
  
  const buffer = await streamToBuffer(archive);
  await storage.writeFile(outputPath, buffer);
  
  return { size: buffer.length };
}
```

### 8.3 Preview Implementation

```typescript
// apps/web/app/preview/[crawlId]/[...path]/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createStorage } from '@/lib/storage';

export async function GET(
  request: NextRequest,
  { params }: { params: { crawlId: string; path: string[] } }
) {
  const { crawlId, path } = params;
  const filePath = path.join('/') || 'index.html';
  
  // Get crawl info
  const crawl = await db.query.crawls.findFirst({
    where: eq(crawls.id, crawlId),
  });
  
  if (!crawl || crawl.status !== 'completed') {
    return NextResponse.json({ error: 'Crawl not found' }, { status: 404 });
  }
  
  // Get storage
  const storage = createStorage(crawl.storageType, await getStorageConfig());
  const fullPath = `${crawl.storagePath}/${filePath}`;
  
  if (!(await storage.exists(fullPath))) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
  
  const content = await storage.readFile(fullPath);
  const contentType = getContentType(filePath);
  
  return new NextResponse(content, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000',
    },
  });
}
```

### 8.4 Job Cancellation

```typescript
// apps/web/app/api/crawls/[crawlId]/cancel/route.ts

export async function POST(
  request: NextRequest,
  { params }: { params: { crawlId: string } }
) {
  const { crawlId } = params;
  
  // Get the job from the queue
  const job = await crawlQueue.getJob(crawlId);
  
  if (job) {
    // If still in queue, remove it
    if (await job.isWaiting() || await job.isDelayed()) {
      await job.remove();
    }
    // If running, signal cancellation
    else if (await job.isActive()) {
      // Publish cancel signal
      await redis.publish(`crawl:${crawlId}:control`, 'cancel');
    }
  }
  
  // Update database
  await db.update(crawls)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(eq(crawls.id, crawlId));
  
  return NextResponse.json({ success: true });
}
```

---

## 9. Technology Stack Summary

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **Frontend** | Next.js 14 (App Router) | Modern React framework with SSR, API routes |
| **UI Components** | shadcn/ui + Tailwind | Flexible, accessible components |
| **Database** | PostgreSQL + Drizzle ORM | Type-safe ORM, excellent migrations |
| **Queue** | BullMQ + Redis | Reliable job processing, progress tracking |
| **Real-time** | Server-Sent Events | Simple, efficient for one-way updates |
| **Storage** | Abstracted (Local/S3/R2) | Flexibility for different deployments |
| **Scraping** | Playwright | Robust browser automation |
| **HTML Parsing** | Cheerio | Fast, jQuery-like HTML manipulation |
| **Archive** | Archiver | Streaming zip creation |
| **Scheduling** | node-cron | Simple cron expressions |
| **Deployment** | Railway/Docker | Easy container deployment |

---

## 10. Deployment Architecture

### Railway Deployment

```
┌─────────────────────────────────────────────────────────────┐
│                        Railway Project                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐    │
│  │   Web App    │   │    Worker    │   │  PostgreSQL  │    │
│  │  (Next.js)   │   │   (Node.js)  │   │              │    │
│  │              │   │              │   │              │    │
│  │  Port 3000   │   │   No port    │   │  Port 5432   │    │
│  └──────────────┘   └──────────────┘   └──────────────┘    │
│         │                  │                  │             │
│         └──────────────────┼──────────────────┘             │
│                            │                                 │
│  ┌──────────────┐         │                                 │
│  │    Redis     │◄────────┘                                 │
│  │              │                                           │
│  │  Port 6379   │                                           │
│  └──────────────┘                                           │
│                                                              │
│  ┌──────────────┐  (Optional - if using R2/S3)             │
│  │   Volume     │                                           │
│  │  /storage    │  Local file storage                       │
│  └──────────────┘                                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/db

# Redis
REDIS_URL=redis://host:6379

# Storage (local)
STORAGE_TYPE=local
STORAGE_PATH=/storage

# Storage (S3/R2)
STORAGE_TYPE=s3
S3_BUCKET=my-bucket
S3_REGION=auto
S3_ENDPOINT=https://xxx.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=xxx
S3_SECRET_ACCESS_KEY=xxx

# App
NEXTAUTH_SECRET=xxx  # If adding auth later
```

---

## 11. Development Workflow

### Local Development

```bash
# Start dependencies
docker-compose up -d postgres redis

# Install dependencies
bun install

# Run migrations
bun run db:migrate

# Start development
bun run dev         # Starts Next.js
bun run worker:dev  # Starts worker (separate terminal)
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: scraper
      POSTGRES_PASSWORD: scraper
      POSTGRES_DB: scraper
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

---

## 12. Future Considerations

### Potential Enhancements

1. **Authentication**: Add NextAuth.js for team access control
2. **Webhooks**: Notify external services on crawl completion
3. **Diff Detection**: Compare crawls to detect site changes
4. **Custom Scripts**: Inject custom JS before/after crawl
5. **API Keys**: Allow programmatic access via API keys
6. **Multi-tenant**: Support for multiple organizations
7. **Crawl Templates**: Pre-configured settings for common Webflow patterns

### Scalability Path

1. **Horizontal Scaling**: Run multiple worker instances
2. **Dedicated Browser Pool**: Separate browser management service
3. **CDN Integration**: Serve previews through CDN
4. **Database Read Replicas**: For heavy read workloads

---

## 13. Implementation Phases

### Phase 1: Core Infrastructure (Week 1-2)
- [ ] Project setup with monorepo structure
- [ ] Database schema and migrations
- [ ] Extract and adapt scraper package
- [ ] Basic storage abstraction (local only)
- [ ] Worker setup with BullMQ

### Phase 2: Web Application (Week 2-3)
- [ ] Next.js app with basic UI
- [ ] Sites CRUD pages
- [ ] Crawl trigger and status pages
- [ ] API routes implementation

### Phase 3: Real-time & Progress (Week 3-4)
- [ ] SSE implementation
- [ ] Live progress tracking
- [ ] Log streaming
- [ ] Crawl cancellation

### Phase 4: Advanced Features (Week 4-5)
- [ ] Scheduling system
- [ ] S3/R2 storage support
- [ ] Archive generation and download
- [ ] Preview functionality

### Phase 5: Polish & Deployment (Week 5-6)
- [ ] Error handling and edge cases
- [ ] UI polish and responsiveness
- [ ] Documentation
- [ ] Railway deployment setup
- [ ] Testing and bug fixes
