import { createSupabaseAdminClient, loadWorkerEnv } from "./lib/runtime.js";
import { runPublisherOnce } from "./lib/publisher-runner.js";

loadWorkerEnv();

const supabase = createSupabaseAdminClient();

runPublisherOnce({ supabase })
  .then(() => process.exit(0))
  .catch(err => {
    console.error("Publisher worker failed:", err);
    process.exit(1);
  });

