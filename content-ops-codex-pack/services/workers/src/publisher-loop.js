import { createSupabaseAdminClient, loadWorkerEnv } from "./lib/runtime.js";
import { runPublisherLoop } from "./lib/publisher-runner.js";

loadWorkerEnv();

const supabase = createSupabaseAdminClient();

runPublisherLoop({ supabase })
  .then(summary => {
    console.log(
      `Publisher loop finished. iterations=${summary.iterations} claimed=${summary.claimed} published=${summary.published} failed=${summary.failed}`
    );
    process.exit(0);
  })
  .catch(err => {
    console.error("Publisher loop failed:", err);
    process.exit(1);
  });

