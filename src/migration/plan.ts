import { hashCanonicalJson, hashMigrationBundle } from "../ir/canonical.js";
import type { JsonValue, MigrationBundle, RecoveryGrade } from "../ir/types.js";
import { assertMigrationBundle } from "../ir/validation.js";
import { normalizeError, Trae2OpenCodeError } from "../shared/errors.js";
import { jsonByteLength, JsonSizeLimitError } from "../shared/json-stream.js";
import {
  MAX_MIGRATION_PLAN_BYTES,
  MAX_OPENCODE_TRANSFER_BYTES,
} from "../shared/limits.js";
import { assertNoCredentials } from "../shared/sensitive.js";
import { createOpenCodeIdentityMap } from "../target/opencode/identity.js";
import {
  mapOpenCodeSession,
  type OpenCodeMapping,
  type OpenCodeTransfer,
} from "../target/opencode/mapping.js";
import {
  resolveOpenCodeDirectory, type DirectoryResolution, type ProjectPathMap,
} from "../target/opencode/project-directory.js";
import { reconcileOpenCodeTransfer, type OpenCodeReconciliation } from "../target/opencode/reconciliation.js";

export interface MigrationPlanOptions {
  namespace?: string;
  recovery?: readonly RecoveryGrade[];
  pathMaps?: readonly ProjectPathMap[];
  fallbackDirectory?: string;
}

export interface PlannedSession {
  sourceId: string;
  targetId: string;
  parentId?: string;
  recovery: RecoveryGrade;
  status: "ready" | "excluded" | "blocked";
  reasons: string[];
  diagnosticCodes: string[];
  directory?: DirectoryResolution;
  transfer?: OpenCodeTransfer;
  transferHash?: string;
  expected?: OpenCodeReconciliation["expected"];
}

export interface MigrationPlan {
  planVersion: 1;
  sourceFingerprint: string;
  irHash: string;
  namespace: string;
  options: MigrationPlanOptions;
  sessions: PlannedSession[];
}

const GRADES: readonly RecoveryGrade[] = ["complete", "partial", "metadata-only", "unrecoverable"];

export function parseRecovery(value?: string): RecoveryGrade[] {
  const grades = value === undefined ? ["complete", "partial"] : value.split(",");
  if (grades.length === 0 || grades.some((grade) => !GRADES.includes(grade as RecoveryGrade))) {
    throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
  }
  return [...new Set(grades)] as RecoveryGrade[];
}

export function parsePathMaps(values: readonly string[] = []): ProjectPathMap[] {
  return values.map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
    }
    return { from: value.slice(0, separator), to: value.slice(separator + 1) };
  });
}

/** Read-only. The exact transfers here are consumed by the migration executor. */
export async function buildMigrationPlan(
  value: MigrationBundle, inputOptions: MigrationPlanOptions = {},
): Promise<MigrationPlan> {
  assertNoCredentials(value);
  assertNoCredentials(inputOptions);
  const bundle = assertMigrationBundle(value);
  const options = structuredClone(inputOptions);
  const recovery = options.recovery ?? parseRecovery();
  if (recovery.length === 0 || recovery.some((grade) => !GRADES.includes(grade))) {
    throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
  }
  const namespace = options.namespace ?? "trae-cn";
  const sourcePlatform = bundle.source.platform;
  const identities = createOpenCodeIdentityMap(bundle, namespace);
  const sessions = new Map(bundle.sessions.map((session) => [session.sourceId, session]));
  const prepared = identities.map((identity) => {
    const session = sessions.get(identity.sourceSessionId)!;
    const item: PlannedSession = {
      sourceId: session.sourceId, targetId: identity.sessionId,
      ...(identity.parentId ? { parentId: identity.parentId } : {}),
      recovery: session.recovery, status: "excluded", reasons: [], diagnosticCodes: [],
    };
    let mapping: OpenCodeMapping | undefined;
    let mappingError: string | undefined;
    if (recovery.includes(session.recovery)) {
      try {
        // Mapping snapshots the caller-owned transcript before the first async directory check.
        mapping = mapOpenCodeSession(bundle, session.sourceId, {
          ...identity,
          directory: process.cwd(),
        });
      } catch (error) {
        mappingError = normalizeError(error).code;
      }
    }
    return { item, sourcePath: session.projectPath, mapping, mappingError };
  });
  const plan: MigrationPlan = {
    planVersion: 1, sourceFingerprint: bundle.source.sourceFingerprint,
    irHash: hashMigrationBundle(bundle), namespace, options,
    sessions: prepared.map(({ item }) => item),
  };
  const planned = new Map(plan.sessions.map((item) => [item.targetId, item]));
  let totalBytes = 0;
  for (const entry of prepared) {
    const { item } = entry;
    if (!recovery.includes(item.recovery)) {
      item.reasons.push("T2O_MIGRATION_RECOVERY_EXCLUDED");
      continue;
    }
    item.status = "blocked";
    const parentUnavailable = item.parentId !== undefined && planned.get(item.parentId)?.status !== "ready";
    if (parentUnavailable) {
      item.reasons.push("T2O_OPENCODE_PARENT_MISSING");
      continue;
    }
    try {
      const directory = await resolveOpenCodeDirectory({
        sourcePath: entry.sourcePath, sourcePlatform,
        pathMaps: options.pathMaps, fallbackDirectory: options.fallbackDirectory,
      });
      item.directory = directory;
      if (!directory.writable || !directory.targetDirectory) {
        item.reasons.push(...directory.reasons);
        continue;
      }
      if (entry.mappingError) {
        item.reasons.push(entry.mappingError);
        continue;
      }
      const mapping = entry.mapping!;
      mapping.transfer.info.location.directory = directory.targetDirectory;
      let bytes: number;
      try {
        bytes = jsonByteLength(
          mapping.transfer as unknown as JsonValue,
          {},
          MAX_OPENCODE_TRANSFER_BYTES,
        );
      } catch (error) {
        if (error instanceof JsonSizeLimitError) {
          throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_TOO_LARGE");
        }
        throw error;
      }
      if (totalBytes > MAX_MIGRATION_PLAN_BYTES - bytes) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_TOO_LARGE");
      }
      totalBytes += bytes;
      item.transfer = mapping.transfer;
      item.transferHash = hashCanonicalJson(mapping.transfer as unknown as JsonValue);
      item.expected = reconcileOpenCodeTransfer(mapping.transfer, mapping.transfer).expected;
      item.diagnosticCodes = mapping.diagnostics.map((issue) => issue.code);
      item.status = "ready";
    } catch (error) {
      item.reasons.push(normalizeError(error).code);
    }
  }
  return plan;
}

/** No transcript, title, directory, raw diagnostic context or target credentials. */
export function summarizeMigrationPlan(plan: MigrationPlan) {
  return {
    planVersion: plan.planVersion, irHash: plan.irHash, sourceFingerprint: plan.sourceFingerprint,
    ready: plan.sessions.filter((item) => item.status === "ready").length,
    excluded: plan.sessions.filter((item) => item.status === "excluded").length,
    blocked: plan.sessions.filter((item) => item.status === "blocked").length,
    sessions: plan.sessions.map((item) => ({
      sourceId: item.sourceId, targetId: item.targetId,
      ...(item.parentId ? { parentId: item.parentId } : {}),
      recovery: item.recovery, status: item.status, reasons: item.reasons,
      diagnosticCodes: item.diagnosticCodes,
      ...(item.directory ? { directory: {
        strategy: item.directory.strategy, exists: item.directory.exists,
        targetHash: hashCanonicalJson(item.directory.targetDirectory),
      } } : {}),
      ...(item.transferHash ? { transferHash: item.transferHash, expected: item.expected } : {}),
    })),
  };
}
