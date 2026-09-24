import { Trae2OpenCodeError } from "../shared/errors.js";
import type { OpenCodeTransfer } from "../target/opencode/mapping.js";
import type { ManifestSession, ManifestStore, MigrationManifest } from "./manifest.js";
import { isOwnedByRun, jsonHash } from "./ownership.js";
import type { MigrationTarget } from "./target.js";

export function authorizeReplacements(manifest: MigrationManifest, previous: MigrationManifest): void {
  if (previous.rollbackState) throw new Trae2OpenCodeError("T2O_MIGRATION_ROLLBACK_STARTED");
  if (jsonHash(manifest.target) !== jsonHash(previous.target)) {
    throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
  }
  const priorById = new Map(previous.sessions.map((item) => [item.targetId, item]));
  for (const item of manifest.sessions.filter((session) => session.state === "pending")) {
    const prior = priorById.get(item.targetId);
    if (!prior) continue;
    const eligible = prior.state === "verified" && prior.created && prior.deletionHash &&
      prior.sourceId === item.sourceId && prior.parentId === item.parentId;
    if (!eligible) throw new Trae2OpenCodeError("T2O_MIGRATION_REPLACEMENT_INVALID");
    item.replacement = { runId: previous.runId, deletionHash: prior.deletionHash!, state: "pending" };
  }
  if (!manifest.sessions.some((item) => item.replacement)) {
    throw new Trae2OpenCodeError("T2O_MIGRATION_REPLACEMENT_INVALID");
  }
}

function matchesPrevious(actual: OpenCodeTransfer, item: ManifestSession): boolean {
  const prior = item.replacement!;
  const owned = isOwnedByRun(actual, { runId: prior.runId }, { ...item, attempts: 1 });
  return owned && jsonHash(actual) === prior.deletionHash;
}

/** Remove only the reviewed old incarnations; every intent is durable before native delete. */
export async function removeReplacements(
  manifest: MigrationManifest, store: ManifestStore, target: MigrationTarget, exclusiveTarget: boolean,
): Promise<void> {
  const pending = manifest.sessions.filter((item) => item.replacement && item.replacement.state !== "deleted");
  if (!pending.length) return;
  if (!exclusiveTarget) throw new Trae2OpenCodeError("T2O_MIGRATION_EXCLUSIVE_REQUIRED");
  if (!target.listChildren || !target.deleteSession) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_DELETE_UNSUPPORTED");
  }
  const byId = new Map(pending.map((item) => [item.targetId, item]));
  // Preflight the complete selection before deleting its first child.
  for (const item of pending) {
    const actual = await target.readSession(item.targetId);
    if (!actual) continue;
    if (!matchesPrevious(actual, item)) {
      throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
    }
    const children = await target.listChildren(item.targetId);
    const unplannedChild = children.some((id) => byId.get(id)?.parentId !== item.targetId);
    if (unplannedChild) throw new Trae2OpenCodeError("T2O_MIGRATION_CHILDREN_PROTECTED");
  }
  for (const item of [...pending].reverse()) {
    const prior = item.replacement!;
    const current = await target.readSession(item.targetId);
    if (current) {
      if (!matchesPrevious(current, item)) throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
      prior.state = "deleting";
      await store.save(manifest);
      try { await target.deleteSession(item.targetId, prior.deletionHash, exclusiveTarget); }
      catch (error) {
        // A lost acknowledgement is recoverable only if the target is now absent.
        if (await target.readSession(item.targetId)) throw error;
      }
    }
    if (await target.readSession(item.targetId)) throw new Trae2OpenCodeError("T2O_OPENCODE_DELETE_FAILED");
    prior.state = "deleted";
    await store.save(manifest);
  }
}
