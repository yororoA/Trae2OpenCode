import { normalizeError, Trae2OpenCodeError } from "../shared/errors.js";
import { targetReconciliation } from "../target/opencode/dialect.js";
import { withManifestStore, type ManifestSession, type MigrationManifest } from "./manifest.js";
import { isOwnedByRun, jsonHash } from "./ownership.js";
import { descriptorDialect, type MigrationTarget } from "./target.js";

type RollbackAction = "delete" | "absent" | "already-rolled-back" | "skip" | "protected";
interface RollbackEntry {
  targetId: string;
  action: RollbackAction;
  codes: string[];
  /** Internal only. A recovered full import is checkpointed before deletion. */
  deletionHash?: string;
}

async function inspectSession(
  item: ManifestSession, manifest: MigrationManifest, target: MigrationTarget,
): Promise<RollbackEntry> {
  const entry: RollbackEntry = { targetId: item.targetId, action: "skip", codes: [] };
  if (item.replacement || item.attempts === 0 || item.state === "skipped") return entry;
  try {
    const actual = await target.readSession(item.targetId);
    if (!actual) {
      const knownAbsent = !item.created || item.state === "deleting" || item.state === "rolled-back";
      if (!knownAbsent) throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
      entry.action = item.state === "rolled-back" ? "already-rolled-back" : "absent";
      return entry;
    }
    const owned = isOwnedByRun(actual, manifest, item);
    if (!owned || item.state === "rolled-back") throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
    const actualHash = jsonHash(actual);
    if (item.deletionHash) {
      if (item.deletionHash !== actualHash) throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
    } else {
      const observed = targetReconciliation(descriptorDialect(manifest.target)).snapshot(actual);
      const recoverableImport = !item.created && jsonHash(observed) === jsonHash(item.expected);
      if (!recoverableImport) throw new Trae2OpenCodeError("T2O_MIGRATION_ROLLBACK_EVIDENCE_MISSING");
    }
    if (!target.deleteSession || !target.listChildren) throw new Trae2OpenCodeError("T2O_OPENCODE_DELETE_UNSUPPORTED");
    entry.action = "delete";
    entry.deletionHash = actualHash;
  } catch (error) {
    entry.action = "protected";
    entry.codes = [normalizeError(error).code];
  }
  return entry;
}

function report(manifest: MigrationManifest, entries: RollbackEntry[], preview: boolean) {
  return {
    command: "rollback", runId: manifest.runId, preview,
    rollbackState: manifest.rollbackState ?? "not-started",
    hasFailures: entries.some((item) => item.action === "protected"),
    eligible: entries.filter((item) => item.action === "delete").length,
    rolledBack: manifest.sessions.filter((item) => item.state === "rolled-back").length,
    skipped: entries.filter((item) => item.action === "skip").length,
    sessions: entries.map(({ targetId, action, codes }) => ({ targetId, action, codes })),
  };
}

/** Default is a read-only preview; confirmation seals the run before any native delete. */
export async function rollbackMigration(
  filename: string, target: MigrationTarget, options: { confirm?: string; exclusiveTarget?: boolean } = {},
) {
  const confirmed = options.confirm !== undefined;
  if (confirmed && !options.exclusiveTarget) throw new Trae2OpenCodeError("T2O_MIGRATION_EXCLUSIVE_REQUIRED");
  return withManifestStore(filename, async (store) => {
    const manifest = await store.read();
    if (confirmed && options.confirm !== manifest.runId) throw new Trae2OpenCodeError("T2O_MIGRATION_CONFIRMATION_REQUIRED");
    if (jsonHash(manifest.target) !== jsonHash(await target.describe())) {
      throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
    }
    const entries: RollbackEntry[] = [];
    for (const item of manifest.sessions) entries.push(await inspectSession(item, manifest, target));
    const byId = new Map(manifest.sessions.map((item) => [item.targetId, item]));
    const deletable = new Set(entries.filter((item) => item.action === "delete").map((item) => item.targetId));
    // Preflight the whole graph: no parent may cascade into an unselected or changed child.
    for (const entry of entries.filter((item) => item.action === "delete")) {
      try {
        const children = await target.listChildren!(entry.targetId);
        const unplannedChild = children.some((id) => !deletable.has(id) || byId.get(id)?.parentId !== entry.targetId);
        if (unplannedChild) throw new Trae2OpenCodeError("T2O_MIGRATION_CHILDREN_PROTECTED");
      } catch (error) {
        entry.action = "protected";
        entry.codes = [normalizeError(error).code];
      }
    }
    if (!confirmed || entries.some((item) => item.action === "protected")) return report(manifest, entries, !confirmed);
    if (manifest.rollbackState === "completed") return report(manifest, entries, false);
    manifest.rollbackState = "in-progress";
    await store.save(manifest);
    for (const entry of [...entries].reverse()) {
      if (entry.action !== "delete" && entry.action !== "absent") continue;
      const item = byId.get(entry.targetId)!;
      const current = await target.readSession(item.targetId);
      if (entry.action === "delete") {
        const unchanged = current && isOwnedByRun(current, manifest, item) && jsonHash(current) === entry.deletionHash;
        if (!unchanged) throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
        if ((await target.listChildren!(item.targetId)).length) {
          throw new Trae2OpenCodeError("T2O_MIGRATION_CHILDREN_PROTECTED");
        }
        item.created = true;
        item.deletionHash = entry.deletionHash;
        item.state = "deleting";
        await store.save(manifest);
        try { await target.deleteSession!(item.targetId, item.deletionHash!, true); }
        catch (error) {
          if (await target.readSession(item.targetId)) throw error;
        }
      } else if (current) {
        throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
      }
      if (await target.readSession(item.targetId)) throw new Trae2OpenCodeError("T2O_OPENCODE_DELETE_FAILED");
      item.state = "rolled-back";
      item.codes = [];
      await store.save(manifest);
      entry.action = "already-rolled-back";
    }
    manifest.rollbackState = "completed";
    await store.save(manifest);
    return report(manifest, entries, false);
  });
}
