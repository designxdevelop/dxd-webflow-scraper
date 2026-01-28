import { startWorker } from "./processor.js";
import { startScheduler } from "./scheduler.js";

console.log("=".repeat(50));
console.log("DXD Webflow Scraper - Background Worker");
console.log("=".repeat(50));

// Start the job processor
const worker = startWorker();

// Start the scheduler
startScheduler();

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
