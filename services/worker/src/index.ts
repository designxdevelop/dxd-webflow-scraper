import { startWorker } from "./processor.js";
import { startScheduler } from "./scheduler.js";
import { startHttpServer } from "./http.js";

console.log("=".repeat(50));
console.log("DXD Webflow Scraper - Background Worker");
console.log("=".repeat(50));

// Start the job processor
const worker = startWorker();

// Start the scheduler
startScheduler();

// Start the HTTP API server (for receiving enqueue requests from Workers API)
const httpPort = parseInt(process.env.WORKER_HTTP_PORT || "3002");
startHttpServer(httpPort);

// Handle graceful shutdown
async function shutdown() {
  console.log("\n[Worker] Shutting down...");

  await worker.close();

  console.log("[Worker] Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("[Worker] Ready to process jobs");
