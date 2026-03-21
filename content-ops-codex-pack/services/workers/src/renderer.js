import { createSupabaseAdminClient, loadWorkerEnv } from "./lib/runtime.js";
import { runRendererUntilDrained } from "./lib/renderer-runner.js";

loadWorkerEnv();

const supabase = createSupabaseAdminClient();

runRendererUntilDrained({ supabase })
  .then(summary => {
    if (summary?.skipped) {
      console.log(
        `Renderer worker skipped. reason=${summary.skipReason || "unknown"} lock_holder=${summary.lockHolderId || "unknown"} lock_expires_at=${summary.lockExpiresAt || "unknown"}`
      );
      process.exit(0);
    }
    console.log(
      `Renderer worker finished. batches=${summary.batches} fetched=${summary.totalFetched} rendered=${summary.totalRendered} retry_scheduled=${summary.totalRetryScheduled} failed=${summary.totalFailed}`
    );
    process.exit(0);
  })
  .catch(err => {
    console.error("Renderer worker failed:", err);
    process.exit(1);
  });
