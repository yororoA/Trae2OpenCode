import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JsonObject } from "../ir/types.js";
import { normalizeError, Trae2OpenCodeError } from "../shared/errors.js";
import type { OpenCodeTransfer } from "../target/opencode/mapping.js";
import { reconcileOpenCodeTransfer } from "../target/opencode/reconciliation.js";
import {
  withManifestStore, type ManifestSession, type ManifestStore, type MigrationManifest,
  type ReconciliationSnapshot,
} from "./manifest.js";
import { summarizeMigrationPlan, type MigrationPlan } from "./plan.js";
import { isOwnedByRun, jsonHash } from "./ownership.js";
import { authorizeReplacements, removeReplacements } from "./replacement.js";
import type { MigrationTarget, MigrationTargetDescriptor } from "./target.js";

export { isOwnedByRun } from "./ownership.js";
const snapshot = (transfer: OpenCodeTransfer) => reconcileOpenCodeTransfer(transfer, transfer).actual;
const equalSnapshot = (left: ReconciliationSnapshot, right: ReconciliationSnapshot) => jsonHash(left) === jsonHash(right);

function ownedTransfer(transfer: OpenCodeTransfer, runId: string): OpenCodeTransfer {
  const copy = structuredClone(transfer);
  const metadata = copy.info.metadata as JsonObject;
  (metadata.trae2opencode as JsonObject).migrationRunId = runId;
  return copy;
}

function createManifest(plan: MigrationPlan, target: MigrationTargetDescriptor): MigrationManifest {
  const runId = randomUUID();
  return {
    manifestVersion: 1, runId, sourceFingerprint: plan.sourceFingerprint, irHash: plan.irHash,
    planHash: jsonHash(summarizeMigrationPlan(plan)), target, revision: 0, checksum: "",
    sessions: plan.sessions.map((item) => {
      const transfer = item.transfer ? ownedTransfer(item.transfer, runId) : undefined;
      return {
        sourceId: item.sourceId, targetId: item.targetId,
        ...(item.parentId ? { parentId: item.parentId } : {}),
        state: item.status === "ready" ? "pending" : item.status,
        created: false, attempts: 0, codes: [...item.reasons, ...item.diagnosticCodes],
        ...(transfer ? { transferHash: jsonHash(transfer), expected: snapshot(transfer) } : {}),
      };
    }),
  };
}

function requireTarget(manifest: MigrationManifest, target: MigrationTargetDescriptor): void {
  if (jsonHash(manifest.target) !== jsonHash(target)) {
    throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
  }
}

/** All checkpoints are outside failure isolation: a persistence failure stops every later write. */
async function executeSession(
  transfer: OpenCodeTransfer, item: ManifestSession, manifest: MigrationManifest,
  target: MigrationTarget, store: ManifestStore, parentSatisfied: boolean,
): Promise<void> {
  let existing: OpenCodeTransfer | null;
  try { existing = await target.readSession(item.targetId); }
  catch (error) {
    item.state = "failed";
    item.codes = [normalizeError(error).code];
    await store.save(manifest);
    return;
  }
  if (existing) {
    const owned = isOwnedByRun(existing, manifest, item);
    item.actual = snapshot(existing);
    if (owned) {
      item.created = true;
      const matches = equalSnapshot(item.expected!, item.actual);
      const changedReadback = item.deletionHash !== undefined && jsonHash(existing) !== item.deletionHash;
      item.state = matches && !changedReadback ? "verified" : "failed";
      item.codes = changedReadback ? ["T2O_MIGRATION_TARGET_CHANGED"] :
        matches ? [] : ["T2O_MIGRATION_PARTIAL_WRITE"];
      // After interruption, only a complete expected transcript can establish new deletion evidence.
      if (matches) item.deletionHash ??= jsonHash(existing);
    } else {
      item.state = item.attempts === 0 ? "skipped" : "failed";
      item.codes = [item.attempts === 0 ? "T2O_OPENCODE_SESSION_CONFLICT" : "T2O_MIGRATION_TARGET_CHANGED"];
    }
    await store.save(manifest);
    return;
  }
  if (item.created) {
    item.state = "failed";
    item.codes = ["T2O_MIGRATION_TARGET_CHANGED"];
    await store.save(manifest);
    return;
  }
  if (!parentSatisfied) {
    item.state = "failed";
    item.codes = ["T2O_OPENCODE_PARENT_MISSING"];
    await store.save(manifest);
    return;
  }
  item.state = "importing";
  item.attempts++;
  delete item.actual;
  item.codes = [];
  await store.save(manifest);
  try {
    // Never treat the CLI exit status as evidence of a complete write.
    await target.importSession(transfer);
  } catch (error) {
    item.codes = [normalizeError(error).code];
  }
  try {
    const actual = await target.readSession(item.targetId);
    const owned = actual && isOwnedByRun(actual, manifest, item);
    if (owned) {
      item.created = true;
      item.deletionHash = jsonHash(actual);
      item.actual = snapshot(actual);
      item.state = equalSnapshot(item.expected!, item.actual) ? "verified" : "failed";
      if (item.state === "failed") item.codes.push("T2O_MIGRATION_PARTIAL_WRITE");
    } else {
      item.state = "failed";
      item.codes.push(actual ? "T2O_MIGRATION_TARGET_CHANGED" : "T2O_OPENCODE_READBACK_INVALID");
    }
  } catch (error) {
    item.state = "failed";
    item.codes.push(normalizeError(error).code);
  }
  await store.save(manifest);
}

export function summarizeManifest(manifest: MigrationManifest) {
  return {
    manifestVersion: manifest.manifestVersion, runId: manifest.runId,
    sourceFingerprint: manifest.sourceFingerprint, irHash: manifest.irHash,
    target: manifest.target, revision: manifest.revision,
    hasFailures: manifest.sessions.some((item) => ["failed", "blocked", "importing", "pending"].includes(item.state)),
    created: manifest.sessions.filter((item) => item.created && !item.replacement).length,
    replaced: manifest.sessions.filter((item) => item.created && item.replacement).length,
    verified: manifest.sessions.filter((item) => item.state === "verified").length,
    skipped: manifest.sessions.filter((item) => item.state === "skipped").length,
    sessions: manifest.sessions.map((item) => structuredClone(item)),
  };
}

export async function migrate(
  inputPlan: MigrationPlan, target: MigrationTarget,
  options: { outputDirectory?: string; resumeManifest?: string; replaceManifest?: string; exclusiveTarget?: boolean },
) {
  const plan = structuredClone(inputPlan);
  const validMode = Boolean(options.outputDirectory) !== Boolean(options.resumeManifest);
  if (!validMode) throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
  if (options.replaceManifest && options.resumeManifest) throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
  if (options.replaceManifest && !options.exclusiveTarget) {
    throw new Trae2OpenCodeError("T2O_MIGRATION_EXCLUSIVE_REQUIRED");
  }
  const descriptor = await target.describe();
  let filename: string;
  if (options.resumeManifest) filename = path.resolve(options.resumeManifest);
  else {
    const directory = path.resolve(options.outputDirectory!);
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch { throw new Trae2OpenCodeError("T2O_MIGRATION_CHECKPOINT_FAILED"); }
    filename = path.join(directory, "migration-manifest.json");
  }
  return withManifestStore(filename, async (store) => {
    const manifest = options.resumeManifest ? await store.read() : createManifest(plan, descriptor);
    requireTarget(manifest, descriptor);
    if (options.replaceManifest) {
      await withManifestStore(options.replaceManifest, async (previousStore) =>
        authorizeReplacements(manifest, await previousStore.read()));
    }
    const changedPlan = manifest.irHash !== plan.irHash || manifest.sourceFingerprint !== plan.sourceFingerprint ||
      manifest.planHash !== jsonHash(summarizeMigrationPlan(plan));
    if (changedPlan) throw new Trae2OpenCodeError("T2O_MIGRATION_PLAN_CHANGED");
    const planned = new Map(plan.sessions.map((item) => [item.targetId, item]));
    // Validate every expected payload before any write, including a resumed checkpoint.
    for (const item of manifest.sessions) {
      const transfer = planned.get(item.targetId)?.transfer;
      if (!transfer) continue;
      const owned = ownedTransfer(transfer, manifest.runId);
      const changedPayload = jsonHash(owned) !== item.transferHash ||
        !equalSnapshot(snapshot(owned), item.expected!);
      if (changedPayload) throw new Trae2OpenCodeError("T2O_MIGRATION_PLAN_CHANGED");
    }
    // Detect a replaced/emptied target or edited successful session before importing anything else.
    for (const item of manifest.sessions.filter((session) => session.state === "verified")) {
      const actual = await target.readSession(item.targetId);
      if (!actual || !isOwnedByRun(actual, manifest, item) || !equalSnapshot(snapshot(actual), item.expected!)) {
        throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
      }
    }
    await store.save(manifest);
    await removeReplacements(manifest, store, target, options.exclusiveTarget === true);
    const byId = new Map(manifest.sessions.map((item) => [item.targetId, item]));
    for (const item of manifest.sessions) {
      const transfer = planned.get(item.targetId)?.transfer;
      if (!transfer || item.state === "verified") continue;
      const parentSatisfied = item.parentId === undefined || byId.get(item.parentId)?.state === "verified";
      await executeSession(ownedTransfer(transfer, manifest.runId), item, manifest, target, store, parentSatisfied);
    }
    return { command: "migrate", manifest: path.basename(filename), ...summarizeManifest(manifest) };
  });
}

export async function verifyMigration(filename: string, target: MigrationTarget) {
  const descriptor = await target.describe();
  return withManifestStore(filename, async (store) => {
    const manifest = await store.read();
    requireTarget(manifest, descriptor);
    const sessions = [];
    for (const item of manifest.sessions) {
      if (item.attempts === 0) {
        sessions.push({ targetId: item.targetId, state: item.state, codes: item.codes });
        continue;
      }
      try {
        const actual = await target.readSession(item.targetId);
        const observed = actual ? snapshot(actual) : undefined;
        const verified = actual && isOwnedByRun(actual, manifest, item) &&
          equalSnapshot(item.expected!, observed!);
        sessions.push({
          targetId: item.targetId, state: verified ? "verified" : "failed",
          codes: verified ? [] : ["T2O_OPENCODE_RECONCILIATION_FAILED"],
          expected: item.expected, ...(observed ? { actual: observed } : {}),
        });
      } catch (error) {
        sessions.push({ targetId: item.targetId, state: "failed", codes: [normalizeError(error).code] });
      }
    }
    return {
      command: "verify", runId: manifest.runId,
      hasFailures: sessions.some((item) => ["failed", "pending", "importing", "blocked"].includes(item.state)),
      sessions,
    };
  });
}
