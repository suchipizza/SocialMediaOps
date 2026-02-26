import { AnyManifestSchema } from "./schema.js";

/**
 * Validate a manifest object. Throws on invalid.
 */
export function validateManifest(input: unknown) {
  return AnyManifestSchema.parse(input);
}
