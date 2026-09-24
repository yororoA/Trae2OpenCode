import * as fs from "node:fs/promises";
import * as path from "node:path";
import { canonicalizeMigrationBundle, hashMigrationBundle } from "../ir/canonical.js";
import { assertMigrationBundle } from "../ir/validation.js";
import type { MigrationBundle } from "../ir/types.js";
import { Trae2OpenCodeError } from "../shared/errors.js";
import { assertNoCredentials } from "../shared/sensitive.js";

const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;

export async function readBundleFile(filename: string): Promise<MigrationBundle> {
  let file: fs.FileHandle | undefined;
  try {
    file = await fs.open(filename, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) throw new Error("Invalid size");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size) throw new Error("File changed");
    const value: unknown = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    assertNoCredentials(value);
    return assertMigrationBundle(value);
  } catch (error) {
    if (error instanceof Trae2OpenCodeError) throw error;
    throw new Trae2OpenCodeError("T2O_MIGRATION_BUNDLE_READ_FAILED");
  } finally { await file?.close(); }
}

/** Exclusive directory ownership prevents overwrites and symlink traversal at the leaf. */
export async function exportBundleFile(bundle: MigrationBundle, outputDirectory: string) {
  assertNoCredentials(bundle);
  const content = canonicalizeMigrationBundle(bundle);
  if (Buffer.byteLength(content, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Trae2OpenCodeError("T2O_TRAE_RUNTIME_LIMIT");
  }
  const directory = path.resolve(outputDirectory);
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
    const file = await fs.open(path.join(directory, "migration-bundle.json"), "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally { await file.close(); }
    return { filename: "migration-bundle.json", irHash: hashMigrationBundle(bundle) };
  } catch {
    if (created) await fs.rm(directory, { recursive: true, force: true });
    throw new Trae2OpenCodeError("T2O_MIGRATION_EXPORT_FAILED");
  }
}

/** Allowlist only: titles, transcript, tool payloads and paths never reach previews. */
export function summarizeBundle(bundle: MigrationBundle) {
  assertNoCredentials(bundle);
  return {
    schemaVersion: bundle.schemaVersion,
    sourceVersion: bundle.source.product.version,
    sourceFingerprint: bundle.source.sourceFingerprint,
    irHash: hashMigrationBundle(bundle),
    projectCount: bundle.projects.length,
    sessions: bundle.sessions.map((session) => ({
      sourceId: session.sourceId, recovery: session.recovery,
      messageCount: session.events.length,
      userCount: session.events.filter((event) => event.type === "user").length,
      assistantCount: session.events.filter((event) => event.type === "assistant").length,
      resourceCount: session.resources.length,
      diagnosticCodes: [...new Set(bundle.diagnostics.filter((diagnostic) =>
        diagnostic.subject?.type === "session" && diagnostic.subject.sourceId === session.sourceId)
        .map((diagnostic) => diagnostic.code))].sort(),
    })),
    diagnosticCodes: [...new Set(bundle.diagnostics.map((diagnostic) => diagnostic.code))].sort(),
  };
}
