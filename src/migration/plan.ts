import { hashCanonicalJson, hashMigrationBundle } from "../ir/canonical.js";
import type { JsonValue, MigrationBundle, RecoveryGrade } from "../ir/types.js";
import { assertMigrationBundle } from "../ir/validation.js";
import { normalizeError, Trae2OpenCodeError } from "../shared/errors.js";
import { assertNoCredentials } from "../shared/sensitive.js";
import { OPENCODE_VERSION, type OpenCodeDialect } from "../target/opencode/contract.js";
import { mapTargetSession, targetReconciliation } from "../target/opencode/dialect.js";
import { createOpenCodeIdentityMap } from "../target/opencode/identity.js";
import type { OpenCodeSession } from "../target/opencode/mapping.js";
import {
  resolveOpenCodeDirectory, type DirectoryResolution, type ProjectPathMap,
} from "../target/opencode/project-directory.js";
import type { OpenCodeReconciliation } from "../target/opencode/reconciliation.js";

export interface MigrationPlanOptions {
  namespace?: string;
  recovery?: readonly RecoveryGrade[];
  pathMaps?: readonly ProjectPathMap[];
  fallbackDirectory?: string;
  /** Set from the verified target before planning; defaults to the v2 contract. */
  dialect?: OpenCodeDialect;
  targetVersion?: string;
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
  transfer?: OpenCodeSession;
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
  const bundle = structuredClone(assertMigrationBundle(value));
  const options = structuredClone(inputOptions);
  const recovery = options.recovery ?? parseRecovery();
  if (recovery.length === 0 || recovery.some((grade) => !GRADES.includes(grade))) {
    throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
  }
  const namespace = options.namespace ?? "trae-cn";
  const dialect = options.dialect ?? "v2";
  const targetVersion = options.targetVersion ?? OPENCODE_VERSION;
  const reconciliation = targetReconciliation(dialect);
  const identities = createOpenCodeIdentityMap(bundle, namespace);
  const sessions = new Map(bundle.sessions.map((session) => [session.sourceId, session]));
  const plan: MigrationPlan = {
    planVersion: 1, sourceFingerprint: bundle.source.sourceFingerprint,
    irHash: hashMigrationBundle(bundle), namespace, options, sessions: [],
  };
  const planned = new Map<string, PlannedSession>();
  let totalBytes = 0;
  for (const identity of identities) {
    const session = sessions.get(identity.sourceSessionId)!;
    const item: PlannedSession = {
      sourceId: session.sourceId, targetId: identity.sessionId,
      ...(identity.parentId ? { parentId: identity.parentId } : {}),
      recovery: session.recovery, status: "excluded", reasons: [], diagnosticCodes: [],
    };
    plan.sessions.push(item);
    planned.set(item.targetId, item);
    if (!recovery.includes(session.recovery)) {
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
        sourcePath: session.projectPath, sourcePlatform: bundle.source.platform,
        pathMaps: options.pathMaps, fallbackDirectory: options.fallbackDirectory,
      });
      item.directory = directory;
      if (!directory.writable || !directory.targetDirectory) {
        item.reasons.push(...directory.reasons);
        continue;
      }
      const mapping = mapTargetSession(bundle, session.sourceId, {
        ...identity, directory: directory.targetDirectory, dialect, targetVersion,
      });
      const bytes = Buffer.byteLength(JSON.stringify(mapping.transfer), "utf8");
      if (bytes > 32 * 1024 * 1024 || totalBytes + bytes > 128 * 1024 * 1024) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_TOO_LARGE");
      }
      totalBytes += bytes;
      item.transfer = mapping.transfer;
      item.transferHash = hashCanonicalJson(mapping.transfer as unknown as JsonValue);
      item.expected = reconciliation.snapshot(mapping.transfer);
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
  const dialect = plan.options.dialect ?? "v2";
  return {
    planVersion: plan.planVersion, irHash: plan.irHash, sourceFingerprint: plan.sourceFingerprint,
    // v2 plans keep their published shape; only a v1 plan advertises an extra field.
    ...(dialect === "v1" ? { dialect, targetVersion: plan.options.targetVersion } : {}),
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
