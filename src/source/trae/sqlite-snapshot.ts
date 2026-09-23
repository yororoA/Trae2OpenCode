import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { Trae2OpenCodeError } from "../../shared/errors.js";

export interface SqliteSnapshotOptions {
  temporaryRoot?: string;
  pagesPerStep?: number;
  timeoutMs?: number;
}

export interface ReadonlySqliteSnapshot {
  databasePath: string;
  directoryPath: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number;
  sourceSidecars: {
    wal: boolean;
    shm: boolean;
  };
  cleanup(): void;
}

const SNAPSHOT_DIRECTORY_PREFIX = "trae2opencode-sqlite-";
const SNAPSHOT_FILENAME = "snapshot.db";
const DEFAULT_PAGES_PER_STEP = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

function hashFileSha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = fs.openSync(filePath, "r");

  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        null,
      );
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }

  return `sha256:${hash.digest("hex")}`;
}

function safeIsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function assertSourceFile(sourcePath: string): void {
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.statSync(sourcePath);
  } catch (cause) {
    throw new Trae2OpenCodeError(
      "T2O_TRAE_SQLITE_SOURCE_NOT_FOUND",
      { cause },
    );
  }

  if (!sourceStat.isFile()) {
    throw new Trae2OpenCodeError(
      "T2O_TRAE_SQLITE_SOURCE_INVALID",
    );
  }
}

function resolvePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Trae2OpenCodeError(
      "T2O_TRAE_SQLITE_SNAPSHOT_FAILED",
    );
  }
  return value;
}

function createSnapshotDirectory(temporaryRoot?: string): string {
  const root = path.resolve(temporaryRoot ?? os.tmpdir());
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const directoryPath = fs.mkdtempSync(
      path.join(root, SNAPSHOT_DIRECTORY_PREFIX),
    );
    fs.chmodSync(directoryPath, 0o700);
    return directoryPath;
  } catch (cause) {
    throw new Trae2OpenCodeError(
      "T2O_TRAE_SQLITE_SNAPSHOT_FAILED",
      { cause },
    );
  }
}

function removeSnapshotDirectory(directoryPath: string): void {
  fs.rmSync(directoryPath, { recursive: true, force: true });
}

function validateSourceDatabase(sourcePath: string): Database.Database {
  let database: Database.Database | undefined;
  try {
    database = new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 5_000,
    });
    database.pragma("query_only = ON");
    database
      .prepare("SELECT name FROM sqlite_schema ORDER BY name LIMIT 1")
      .get();
  } catch (cause) {
    database?.close();
    throw new Trae2OpenCodeError(
      "T2O_TRAE_SQLITE_SOURCE_INVALID",
      { cause },
    );
  }
  return database;
}

function validateSnapshotDatabase(databasePath: string): number {
  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    database.pragma("query_only = ON");
    const rows = database.pragma("quick_check") as Array<
      Record<string, unknown>
    >;
    const isValid =
      rows.length === 1 && Object.values(rows[0])[0] === "ok";
    if (!isValid) {
      throw new Trae2OpenCodeError(
        "T2O_TRAE_SQLITE_SNAPSHOT_INVALID",
      );
    }

    const pageCount = database.pragma("page_count", {
      simple: true,
    });
    if (
      typeof pageCount !== "number" ||
      !Number.isInteger(pageCount) ||
      pageCount < 0
    ) {
      throw new Trae2OpenCodeError(
        "T2O_TRAE_SQLITE_SNAPSHOT_INVALID",
      );
    }
    return pageCount;
  } catch (cause) {
    if (
      cause instanceof Trae2OpenCodeError &&
      cause.code === "T2O_TRAE_SQLITE_SNAPSHOT_INVALID"
    ) {
      throw cause;
    }
    throw new Trae2OpenCodeError(
      "T2O_TRAE_SQLITE_SNAPSHOT_INVALID",
      { cause },
    );
  } finally {
    database?.close();
  }
}

function finalizeSnapshotDatabase(databasePath: string): void {
  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath, {
      fileMustExist: true,
    });
    const journalMode = database.pragma("journal_mode = DELETE", {
      simple: true,
    });
    if (
      typeof journalMode !== "string" ||
      journalMode.toLowerCase() !== "delete"
    ) {
      throw new Trae2OpenCodeError(
        "T2O_TRAE_SQLITE_SNAPSHOT_INVALID",
      );
    }
  } catch (cause) {
    if (
      cause instanceof Trae2OpenCodeError &&
      cause.code === "T2O_TRAE_SQLITE_SNAPSHOT_INVALID"
    ) {
      throw cause;
    }
    throw new Trae2OpenCodeError(
      "T2O_TRAE_SQLITE_SNAPSHOT_INVALID",
      { cause },
    );
  } finally {
    database?.close();
  }

  fs.rmSync(`${databasePath}-wal`, { force: true });
  fs.rmSync(`${databasePath}-shm`, { force: true });
}

export async function createReadonlySqliteSnapshot(
  sourcePath: string,
  options: SqliteSnapshotOptions = {},
): Promise<ReadonlySqliteSnapshot> {
  assertSourceFile(sourcePath);
  const pagesPerStep = resolvePositiveInteger(
    options.pagesPerStep,
    DEFAULT_PAGES_PER_STEP,
  );
  const timeoutMs = resolvePositiveInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
  );
  const sourceSidecars = {
    wal: safeIsFile(`${sourcePath}-wal`),
    shm: safeIsFile(`${sourcePath}-shm`),
  };
  const directoryPath = createSnapshotDirectory(options.temporaryRoot);
  const databasePath = path.join(directoryPath, SNAPSHOT_FILENAME);
  let sourceDatabase: Database.Database | undefined;

  try {
    sourceDatabase = validateSourceDatabase(sourcePath);
    const startedAt = Date.now();
    await sourceDatabase.backup(databasePath, {
      progress() {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Trae2OpenCodeError(
            "T2O_TRAE_SQLITE_SNAPSHOT_FAILED",
          );
        }
        return pagesPerStep;
      },
    });
  } catch (cause) {
    removeSnapshotDirectory(directoryPath);
    if (
      cause instanceof Trae2OpenCodeError &&
      cause.code === "T2O_TRAE_SQLITE_SOURCE_INVALID"
    ) {
      throw cause;
    }
    throw new Trae2OpenCodeError(
      "T2O_TRAE_SQLITE_SNAPSHOT_FAILED",
      { cause },
    );
  } finally {
    sourceDatabase?.close();
  }

  try {
    finalizeSnapshotDatabase(databasePath);
    fs.chmodSync(databasePath, 0o600);
    const pageCount = validateSnapshotDatabase(databasePath);
    const sizeBytes = fs.statSync(databasePath).size;
    let cleanedUp = false;

    return {
      databasePath,
      directoryPath,
      sizeBytes,
      sha256: hashFileSha256(databasePath),
      pageCount,
      sourceSidecars,
      cleanup() {
        if (cleanedUp) return;
        removeSnapshotDirectory(directoryPath);
        cleanedUp = true;
      },
    };
  } catch (cause) {
    removeSnapshotDirectory(directoryPath);
    if (
      cause instanceof Trae2OpenCodeError &&
      cause.code === "T2O_TRAE_SQLITE_SNAPSHOT_INVALID"
    ) {
      throw cause;
    }
    throw new Trae2OpenCodeError(
      "T2O_TRAE_SQLITE_SNAPSHOT_INVALID",
      { cause },
    );
  }
}

export async function withReadonlySqliteSnapshot<T>(
  sourcePath: string,
  callback: (snapshot: ReadonlySqliteSnapshot) => T | Promise<T>,
  options: SqliteSnapshotOptions = {},
): Promise<T> {
  const snapshot = await createReadonlySqliteSnapshot(
    sourcePath,
    options,
  );
  try {
    return await callback(snapshot);
  } finally {
    snapshot.cleanup();
  }
}
