import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Ajv } from "ajv";
import Database from "better-sqlite3";
import { hashCanonicalJson } from "../ir/canonical.js";
import type { JsonValue } from "../ir/types.js";
import { Trae2OpenCodeError } from "../shared/errors.js";
import { assertNoCredentials } from "../shared/sensitive.js";
import { SUPPORTED_OPENCODE_VERSIONS } from "../target/opencode/contract.js";
import type { OpenCodeReconciliation } from "../target/opencode/reconciliation.js";
import type { MigrationTargetDescriptor } from "./target.js";

export type SessionState = "pending" | "importing" | "verified" | "failed" | "skipped" | "excluded" | "blocked" |
  "deleting" | "rolled-back";
export type ReconciliationSnapshot = OpenCodeReconciliation["expected"];
export interface ManifestSession {
  sourceId: string;
  targetId: string;
  parentId?: string;
  state: SessionState;
  created: boolean;
  attempts: number;
  codes: string[];
  transferHash?: string;
  expected?: ReconciliationSnapshot;
  actual?: ReconciliationSnapshot;
  /** Exact first readback, including native projections. Never refreshed after target edits. */
  deletionHash?: string;
  replacement?: {
    runId: string;
    deletionHash: string;
    state: "pending" | "deleting" | "deleted";
  };
}
export interface MigrationManifest {
  manifestVersion: 1;
  runId: string;
  sourceFingerprint: string;
  irHash: string;
  planHash: string;
  target: MigrationTargetDescriptor;
  revision: number;
  rollbackState?: "in-progress" | "completed";
  sessions: ManifestSession[];
  checksum: string;
}

const hash = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };
const counter = { type: "integer", minimum: 0 };
const snapshot = {
  type: "object", additionalProperties: false,
  required: ["counts", "messagesSha256", "infoSha256"],
  properties: {
    messagesSha256: hash, infoSha256: hash,
    counts: {
      type: "object", additionalProperties: false,
      required: ["messages", "users", "assistants", "text", "reasoning", "tools"],
      properties: Object.fromEntries(
        ["messages", "users", "assistants", "text", "reasoning", "tools"].map((key) => [key, counter]),
      ),
    },
  },
};
const validate = new Ajv().compile({
  type: "object", additionalProperties: false,
  required: ["manifestVersion", "runId", "sourceFingerprint", "irHash", "planHash", "target", "revision", "sessions", "checksum"],
  properties: {
    manifestVersion: { const: 1 }, runId: { type: "string", pattern: "^[a-f0-9-]{36}$" },
    sourceFingerprint: hash, irHash: hash, planHash: hash, revision: counter, checksum: hash,
    rollbackState: { enum: ["in-progress", "completed"] },
    target: {
      type: "object", additionalProperties: false,
      required: ["endpointHash", "binaryVersion", "serverVersion", "schemaHash", "fingerprint"],
      properties: {
        endpointHash: hash, schemaHash: hash, fingerprint: hash,
        binaryVersion: { enum: [...SUPPORTED_OPENCODE_VERSIONS] },
        serverVersion: { enum: [...SUPPORTED_OPENCODE_VERSIONS] },
      },
    },
    sessions: {
      type: "array", maxItems: 100000, items: {
        type: "object", additionalProperties: false,
        required: ["sourceId", "targetId", "state", "created", "attempts", "codes"],
        properties: {
          sourceId: { type: "string", minLength: 1, maxLength: 4096 },
          targetId: { type: "string", pattern: "^ses_[a-zA-Z0-9_-]+$" },
          parentId: { type: "string", pattern: "^ses_[a-zA-Z0-9_-]+$" },
          state: { enum: ["pending", "importing", "verified", "failed", "skipped", "excluded", "blocked", "deleting", "rolled-back"] },
          created: { type: "boolean" }, attempts: counter,
          codes: { type: "array", items: { type: "string", pattern: "^T2O_[A-Z0-9_]+$" } },
          transferHash: hash, expected: snapshot, actual: snapshot, deletionHash: hash,
          replacement: {
            type: "object", additionalProperties: false,
            required: ["runId", "deletionHash", "state"],
            properties: {
              runId: { type: "string", pattern: "^[a-f0-9-]{36}$" },
              deletionHash: hash, state: { enum: ["pending", "deleting", "deleted"] },
            },
          },
        },
      },
    },
  },
});

function checksum(manifest: MigrationManifest): string {
  const { checksum: _checksum, ...body } = manifest;
  return hashCanonicalJson(body as unknown as JsonValue);
}

export function assertManifest(value: unknown): asserts value is MigrationManifest {
  assertNoCredentials(value);
  if (!validate(value)) throw new Trae2OpenCodeError("T2O_MIGRATION_MANIFEST_INVALID");
  const manifest = value as MigrationManifest;
  const seen = new Set<string>();
  const sourceIds = new Set<string>();
  for (const session of manifest.sessions) {
    const invalidGraph = seen.has(session.targetId) || sourceIds.has(session.sourceId) ||
      (session.parentId !== undefined && !seen.has(session.parentId));
    const needsExpected = !["excluded", "blocked"].includes(session.state);
    const rollbackSession = session.state === "deleting" || session.state === "rolled-back";
    const invalidRollback = (rollbackSession && (!manifest.rollbackState || session.replacement || session.attempts === 0)) ||
      (session.state === "deleting" && (!session.created || !session.deletionHash || manifest.rollbackState === "completed"));
    const invalidState = (needsExpected && (!session.expected || !session.transferHash)) ||
      (session.state === "verified" && (!session.created || !session.actual)) ||
      (session.created && session.attempts === 0) ||
      (session.deletionHash !== undefined && !session.created) ||
      (session.replacement !== undefined && (!session.expected || !session.transferHash ||
        session.replacement.runId === manifest.runId ||
        (session.replacement.state !== "deleted" && session.attempts > 0)));
    if (invalidGraph || invalidState || invalidRollback) throw new Trae2OpenCodeError("T2O_MIGRATION_MANIFEST_INVALID");
    seen.add(session.targetId);
    sourceIds.add(session.sourceId);
  }
  if (manifest.checksum !== checksum(manifest)) {
    throw new Trae2OpenCodeError("T2O_MIGRATION_MANIFEST_INVALID");
  }
}

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

export async function readManifest(filename: string): Promise<MigrationManifest> {
  let file: fs.FileHandle | undefined;
  try {
    if ((await fs.lstat(filename)).isSymbolicLink()) throw new Error("Symlink");
    file = await fs.open(filename, constants.O_RDONLY | noFollow);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_MANIFEST_BYTES) throw new Error("Invalid file");
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size !== stat.size) throw new Error("File changed");
    const value: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    assertManifest(value);
    return value;
  } catch {
    throw new Trae2OpenCodeError("T2O_MIGRATION_MANIFEST_INVALID");
  } finally { await file?.close(); }
}

export interface ManifestStore {
  read(): Promise<MigrationManifest>;
  save(manifest: MigrationManifest): Promise<void>;
}

/** SQLite supplies a crash-released OS file lock; this is our own lock file, never the target DB. */
export async function withManifestStore<T>(
  filename: string, operation: (store: ManifestStore) => Promise<T>,
): Promise<T> {
  const resolved = path.resolve(filename);
  const directory = path.dirname(resolved);
  const lockPath = `${resolved}.lock`;
  let database: Database.Database | undefined;
  try {
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Invalid directory");
    try {
      const lock = await fs.open(lockPath, "wx", 0o600);
      await lock.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Invalid lock");
    database = new Database(lockPath, { timeout: 0 });
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database?.close();
    const busy = (error as { code?: string }).code === "SQLITE_BUSY";
    throw new Trae2OpenCodeError(busy ? "T2O_MIGRATION_LOCKED" : "T2O_MIGRATION_CHECKPOINT_FAILED");
  }
  try {
    return await operation({
      read: () => readManifest(resolved),
      async save(manifest) {
        const temporary = path.join(directory, `.t2o-checkpoint-${randomUUID()}.tmp`);
        try {
          const next = structuredClone(manifest);
          next.revision++;
          next.checksum = checksum(next);
          assertManifest(next);
          const content = JSON.stringify(next);
          if (Buffer.byteLength(content) > MAX_MANIFEST_BYTES) throw new Error("Size limit");
          const file = await fs.open(temporary, "wx", 0o600);
          try { await file.writeFile(content); await file.sync(); }
          finally { await file.close(); }
          await fs.rename(temporary, resolved);
          if (process.platform !== "win32") {
            const parent = await fs.open(directory, "r");
            try { await parent.sync(); } finally { await parent.close(); }
          }
          // Keep session object identity: the executor holds the current item across saves.
          manifest.revision = next.revision;
          manifest.checksum = next.checksum;
        } catch {
          throw new Trae2OpenCodeError("T2O_MIGRATION_CHECKPOINT_FAILED");
        } finally { await fs.rm(temporary, { force: true }); }
      },
    });
  } finally { database.close(); }
}
