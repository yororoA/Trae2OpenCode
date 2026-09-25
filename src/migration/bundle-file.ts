import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hashMigrationBundle } from "../ir/canonical.js";
import { assertMigrationBundle } from "../ir/validation.js";
import type { JsonValue, MigrationBundle } from "../ir/types.js";
import { Trae2OpenCodeError } from "../shared/errors.js";
import {
  createStreamingJsonParser,
  JsonSizeLimitError,
  writeJson,
} from "../shared/json-stream.js";
import { MAX_BUNDLE_BYTES, MEBIBYTE } from "../shared/limits.js";
import { assertNoCredentials } from "../shared/sensitive.js";

const READ_CHUNK_BYTES = MEBIBYTE;
const CANONICAL_OPTIONS = {
  pretty: true,
  sortKeys: true,
  trailingNewline: true,
} as const;

export async function readBundleFile(filename: string): Promise<MigrationBundle> {
  let file: fs.FileHandle | undefined;
  try {
    file = await fs.open(filename, "r");
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Trae2OpenCodeError("T2O_MIGRATION_BUNDLE_READ_FAILED");
    }
    if (stat.size > MAX_BUNDLE_BYTES) {
      throw new Trae2OpenCodeError("T2O_MIGRATION_BUNDLE_TOO_LARGE");
    }
    const parser = createStreamingJsonParser();
    const bytes = Buffer.alloc(Math.min(Math.max(stat.size, 1), READ_CHUNK_BYTES));
    let offset = 0;
    while (offset < stat.size) {
      const length = Math.min(bytes.length, stat.size - offset);
      const read = await file.read(bytes, 0, length, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
      try {
        parser.write(bytes.subarray(0, read.bytesRead));
      } catch (error) {
        throw new Trae2OpenCodeError("T2O_MIGRATION_BUNDLE_INVALID_JSON", { cause: error });
      }
    }
    if (offset !== stat.size) throw new Error("File changed");
    if ((await file.read(Buffer.alloc(1), 0, 1, null)).bytesRead !== 0) throw new Error("File changed");
    let value: unknown;
    try {
      value = parser.end();
    } catch (error) {
      throw new Trae2OpenCodeError("T2O_MIGRATION_BUNDLE_INVALID_JSON", { cause: error });
    }
    assertNoCredentials(value);
    return assertMigrationBundle(value);
  } catch (error) {
    if (error instanceof Trae2OpenCodeError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Trae2OpenCodeError("T2O_MIGRATION_BUNDLE_NOT_FOUND");
    }
    throw new Trae2OpenCodeError("T2O_MIGRATION_BUNDLE_READ_FAILED");
  } finally { await file?.close(); }
}

/** Exclusive directory ownership prevents overwrites and symlink traversal at the leaf. */
export async function exportBundleFile(bundle: MigrationBundle, outputDirectory: string) {
  assertNoCredentials(bundle);
  const validated = assertMigrationBundle(bundle);
  const directory = path.resolve(outputDirectory);
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
    const file = await fs.open(path.join(directory, "migration-bundle.json"), "wx", 0o600);
    try {
      await writeJson(
        file,
        validated as unknown as JsonValue,
        CANONICAL_OPTIONS,
        MAX_BUNDLE_BYTES,
      );
      await file.sync();
    } finally { await file.close(); }
    return { filename: "migration-bundle.json", irHash: hashMigrationBundle(validated) };
  } catch (error) {
    if (created) await fs.rm(directory, { recursive: true, force: true });
    if (error instanceof JsonSizeLimitError) {
      throw new Trae2OpenCodeError("T2O_TRAE_RUNTIME_LIMIT");
    }
    if (error instanceof Trae2OpenCodeError) throw error;
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
