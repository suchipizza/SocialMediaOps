import { createSupabaseAdminClient, loadWorkerEnv } from "./lib/runtime.js";
import { runRendererUntilDrained } from "./lib/renderer-runner.js";

loadWorkerEnv();

const supabase = createSupabaseAdminClient();

runRendererUntilDrained({ supabase })
  .then(summary => {
    console.log(
      `Renderer worker finished. batches=${summary.batches} fetched=${summary.totalFetched} rendered=${summary.totalRendered} failed=${summary.totalFailed}`
    );
    process.exit(0);
  })
  .catch(err => {
    console.error("Renderer worker failed:", err);
    process.exit(1);
  });

