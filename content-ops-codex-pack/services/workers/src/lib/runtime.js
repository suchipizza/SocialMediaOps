import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import dotenv from "dotenv";

let envLoaded = false;

export function getRepoRoot() {
  const cwd = process.cwd();
  if (cwd.endsWith(`${path.sep}services${path.sep}workers`)) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

export function loadWorkerEnv() {
  if (envLoaded) return;
  dotenv.config({ path: process.env.DOTENV_PATH || path.join(getRepoRoot(), ".env") });
  envLoaded = true;
}

export function createSupabaseAdminClient() {
  loadWorkerEnv();
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

