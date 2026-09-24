import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JsonObject } from "../ir/types.js";
import { normalizeError, Trae2OpenCodeError } from "../shared/errors.js";
import { assertNoCredentials } from "../shared/sensitive.js";
import { isSupportedOpenCodeVersion } from "../target/opencode/contract.js";
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

function isCompatibleTargetChange(
  previous: MigrationTargetDescriptor,
  current: MigrationTargetDescriptor,
): boolean {
  const endpointOrVersionChanged = previous.endpointHash !== current.endpointHash ||
    previous.binaryVersion !== current.binaryVersion ||
    previous.serverVersion !== current.serverVersion;
  return endpointOrVersionChanged &&
    isSupportedOpenCodeVersion(previous.binaryVersion) &&
    isSupportedOpenCodeVersion(previous.serverVersion) &&
    isSupportedOpenCodeVersion(current.binaryVersion) &&
    isSupportedOpenCodeVersion(current.serverVersion) &&
    previous.schemaHash === current.schemaHash;
}

/**
 * A supported endpoint/version change can be rebound only when an unchanged,
 * tool-owned target session proves that the target reaches the same data.
 */
async function requireOrRebindTarget(
  manifest: MigrationManifest,
  descriptor: MigrationTargetDescriptor,
  target: MigrationTarget,
  store: ManifestStore,
): Promise<void> {
  // #region debug-point B:target-descriptor-comparison
  await fs.readFile(path.join(process.cwd(), ".dbg/resume-target-mismatch.env"), "utf8").then(async (content) => {
    const debugUrl = content.match(/^DEBUG_SERVER_URL=(.+)$/m)?.[1];
    if (debugUrl) await fetch(debugUrl, { method: "POST", body: JSON.stringify({ sessionId: "resume-target-mismatch", runId: "post-fix", hypothesisId: "B", location: "executor:require-or-rebind", msg: "[DEBUG] Comparing current and manifest target descriptors", data: { exactMatch: jsonHash(manifest.target) === jsonHash(descriptor), endpointChanged: manifest.target.endpointHash !== descriptor.endpointHash, binaryVersionMatch: manifest.target.binaryVersion === descriptor.binaryVersion, serverVersionMatch: manifest.target.serverVersion === descriptor.serverVersion, schemaMatch: manifest.target.schemaHash === descriptor.schemaHash }, ts: Date.now() }) });
  }).catch(() => {});
  // #endregion
  if (jsonHash(manifest.target) === jsonHash(descriptor)) return;
  if (!isCompatibleTargetChange(manifest.target, descriptor)) {
    throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
  }
  const candidates = manifest.sessions.filter((item) =>
    item.state === "verified" && item.created &&
    item.expected !== undefined && item.deletionHash !== undefined);
  let matched = false;
  for (const item of candidates) {
    const actual = await target.readSession(item.targetId);
    // #region debug-point C:rebind-candidate-evidence
    await fs.readFile(path.join(process.cwd(), ".dbg/resume-target-mismatch.env"), "utf8").then(async (content) => {
      const debugUrl = content.match(/^DEBUG_SERVER_URL=(.+)$/m)?.[1];
      if (debugUrl) await fetch(debugUrl, { method: "POST", body: JSON.stringify({ sessionId: "resume-target-mismatch", runId: "post-fix", hypothesisId: "C", location: "executor:rebind-candidate", msg: "[DEBUG] Evaluated endpoint rebind evidence", data: { candidateCount: candidates.length, actualPresent: actual !== null, owned: actual ? isOwnedByRun(actual, manifest, item) : false, snapshotMatches: actual ? equalSnapshot(snapshot(actual), item.expected!) : false, deletionHashMatches: actual ? jsonHash(actual) === item.deletionHash : false }, ts: Date.now() }) });
    }).catch(() => {});
    // #endregion
    if (actual && isOwnedByRun(actual, manifest, item) &&
      equalSnapshot(snapshot(actual), item.expected!) &&
      jsonHash(actual) === item.deletionHash) {
      matched = true;
      break;
    }
  }
  // #region debug-point E:rebind-decision
  await fs.readFile(path.join(process.cwd(), ".dbg/resume-target-mismatch.env"), "utf8").then(async (content) => {
    const debugUrl = content.match(/^DEBUG_SERVER_URL=(.+)$/m)?.[1];
    if (debugUrl) await fetch(debugUrl, { method: "POST", body: JSON.stringify({ sessionId: "resume-target-mismatch", runId: "post-fix", hypothesisId: "E", location: "executor:rebind-decision", msg: "[DEBUG] Endpoint rebind evidence decision", data: { candidateCount: candidates.length, matched }, ts: Date.now() }) });
  }).catch(() => {});
  // #endregion
  if (!matched) throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
  manifest.target = structuredClone(descriptor);
  await store.save(manifest);
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
  assertNoCredentials(inputPlan);
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
    if (manifest.rollbackState) throw new Trae2OpenCodeError("T2O_MIGRATION_ROLLBACK_STARTED");
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
    await requireOrRebindTarget(manifest, descriptor, target, store);
    if (options.replaceManifest) {
      await withManifestStore(options.replaceManifest, async (previousStore) => {
        const previous = await previousStore.read();
        if (previous.rollbackState) {
          throw new Trae2OpenCodeError("T2O_MIGRATION_ROLLBACK_STARTED");
        }
        await requireOrRebindTarget(previous, descriptor, target, previousStore);
        authorizeReplacements(manifest, previous);
      });
    }
    // Detect a replaced/emptied target or edited successful session before importing anything else.
    for (const item of manifest.sessions.filter((session) => session.state === "verified")) {
      const actual = await target.readSession(item.targetId);
      const changedReadback = actual && item.deletionHash !== undefined &&
        jsonHash(actual) !== item.deletionHash;
      if (!actual || !isOwnedByRun(actual, manifest, item) ||
        !equalSnapshot(snapshot(actual), item.expected!) || changedReadback) {
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
        if (item.state === "deleting" || item.state === "rolled-back") {
          const removed = item.state === "rolled-back" && !actual;
          sessions.push({
            targetId: item.targetId, state: removed ? "rolled-back" : "failed",
            codes: removed ? [] : ["T2O_OPENCODE_RECONCILIATION_FAILED"],
          });
          continue;
        }
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
      ...(manifest.rollbackState ? { rollbackState: manifest.rollbackState } : {}),
      hasFailures: manifest.rollbackState === "in-progress" ||
        sessions.some((item) => ["failed", "pending", "importing", "blocked"].includes(item.state)),
      sessions,
    };
  });
}
