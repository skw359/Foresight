/**
 * Pure path-containment guard, isolated from config so it can be unit-tested
 * without loading the environment. Used by the recordings routes before
 * serving any file off disk (defense-in-depth on top of the strict segment
 * filename parse).
 */
import path from "node:path";

/**
 * True iff `target` resolves to a location strictly inside `base`. Rejects `..`
 * traversal and absolute escapes; returns false when target equals base.
 */
export function isPathWithin(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
