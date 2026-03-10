export async function claimWorkerLease({
  supabase,
  lockKey,
  holderId,
  leaseSeconds = Number.parseInt(process.env.WORKER_SUPERVISOR_LEASE_SECONDS || "60", 10),
  metadata = {}
}) {
  const lease = Number.isFinite(leaseSeconds) ? Math.max(leaseSeconds, 5) : 60;
  const { data, error } = await supabase.rpc("claim_worker_lease", {
    p_lock_key: lockKey,
    p_holder_id: holderId,
    p_lease_seconds: lease,
    p_metadata: metadata || {}
  });
  if (error) {
    throw new Error(`worker_lease_claim_failed:${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : null;
  return {
    acquired: Boolean(row?.acquired),
    holderId: String(row?.holder_id || ""),
    leaseExpiresAt: row?.lease_expires_at || null
  };
}

export async function releaseWorkerLease({
  supabase,
  lockKey,
  holderId
}) {
  const { data, error } = await supabase.rpc("release_worker_lease", {
    p_lock_key: lockKey,
    p_holder_id: holderId
  });
  if (error) {
    throw new Error(`worker_lease_release_failed:${error.message}`);
  }
  return Boolean(data);
}

