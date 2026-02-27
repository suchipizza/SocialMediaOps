import path from "node:path";
import fs from "node:fs/promises";
import { createSupabaseServerClient, getSupabaseStorageBucket } from "./supabase";

type SupabaseLike = ReturnType<typeof createSupabaseServerClient>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getRepoRoot() {
  const cwd = process.cwd();
  if (cwd.endsWith(`${path.sep}apps${path.sep}web`)) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

function chunk<T>(values: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

async function listPagedFolderEntries(
  supabase: SupabaseLike,
  bucket: string,
  prefix: string
) {
  const items: any[] = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit, offset, sortBy: { column: "name", order: "asc" } });
    if (error) {
      throw new Error(`storage_list_failed:${prefix}:${error.message}`);
    }
    const page = data || [];
    items.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return items;
}

async function listFilesRecursively(
  supabase: SupabaseLike,
  bucket: string,
  prefix: string,
  maxDepth = 5
) {
  const files: string[] = [];
  const queue: Array<{ prefix: string; depth: number }> = [{ prefix, depth: 0 }];

  while (queue.length) {
    const current = queue.shift()!;
    const entries = await listPagedFolderEntries(supabase, bucket, current.prefix);
    for (const entry of entries) {
      const childPath = `${current.prefix}/${entry.name}`.replace(/^\/+/, "");
      const isFolder = entry?.id === null && entry?.metadata === null;
      if (isFolder) {
        if (current.depth < maxDepth) {
          queue.push({ prefix: childPath, depth: current.depth + 1 });
        }
        continue;
      }
      files.push(childPath);
    }
  }

  return files;
}

async function cleanupStaleLocalQueuePreviews(validPostIds: Set<string>) {
  const root = path.join(getRepoRoot(), ".cache", "queue-previews");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const stale = entries
    .filter(entry => entry.isDirectory() && UUID_RE.test(entry.name) && !validPostIds.has(entry.name))
    .map(entry => entry.name);

  for (const postId of stale) {
    await fs.rm(path.join(root, postId), { recursive: true, force: true }).catch(() => {});
  }

  return stale.length;
}

async function cleanupStaleRenderStorage(supabase: SupabaseLike, validPostIds: Set<string>) {
  const bucket = getSupabaseStorageBucket();
  const rootEntries = await listPagedFolderEntries(supabase, bucket, "renders");
  const stalePostDirs = rootEntries
    .map(entry => String(entry?.name || "").trim())
    .filter(name => UUID_RE.test(name) && !validPostIds.has(name));

  let removedFiles = 0;
  for (const postId of stalePostDirs) {
    const files = await listFilesRecursively(supabase, bucket, `renders/${postId}`);
    for (const part of chunk(files, 100)) {
      const { error } = await supabase.storage.from(bucket).remove(part);
      if (error) {
        throw new Error(`storage_remove_failed:${postId}:${error.message}`);
      }
      removedFiles += part.length;
    }
  }

  return { stalePostDirs: stalePostDirs.length, removedFiles };
}

export async function cleanupStalePostArtifacts(input?: { supabase?: SupabaseLike }) {
  const supabase = input?.supabase || createSupabaseServerClient();

  const { data: posts, error } = await supabase.from("posts").select("id");
  if (error) {
    throw new Error(`posts_fetch_failed:${error.message}`);
  }

  const validPostIds = new Set((posts || []).map(post => post.id));
  const removedLocalPreviewDirs = await cleanupStaleLocalQueuePreviews(validPostIds);
  const renderCleanup = await cleanupStaleRenderStorage(supabase, validPostIds);

  return {
    removedLocalPreviewDirs,
    staleRenderPostDirs: renderCleanup.stalePostDirs,
    removedStorageFiles: renderCleanup.removedFiles
  };
}
