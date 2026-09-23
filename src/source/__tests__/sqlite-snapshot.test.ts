import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  createReadonlySqliteSnapshot,
  withReadonlySqliteSnapshot,
} from "../trae/sqlite-snapshot.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "trae-sqlite-snapshot-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function hashFile(filePath: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function createSourceDatabase(
  sourcePath: string,
  journalMode: "delete" | "wal",
): Database.Database {
  const database = new Database(sourcePath);
  database.pragma(`journal_mode = ${journalMode}`);
  if (journalMode === "wal") {
    database.pragma("wal_autocheckpoint = 0");
  }
  database.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  return database;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("createReadonlySqliteSnapshot", () => {
  it("includes committed WAL data without changing source DB or WAL bytes", async () => {
    const root = createTemporaryDirectory();
    const snapshotRoot = path.join(root, "snapshots");
    const sourcePath = path.join(root, "state.vscdb");
    const sourceDatabase = createSourceDatabase(sourcePath, "wal");
    const insertMany = sourceDatabase.transaction(() => {
      const insert = sourceDatabase.prepare(
        "INSERT INTO events (value) VALUES (?)",
      );
      for (let index = 0; index < 250; index += 1) {
        insert.run(`event-${index}`);
      }
    });
    insertMany();

    const walPath = `${sourcePath}-wal`;
    assert.equal(fs.existsSync(walPath), true);
    const sourceHashBefore = hashFile(sourcePath);
    const walHashBefore = hashFile(walPath);
    const snapshot = await createReadonlySqliteSnapshot(sourcePath, {
      temporaryRoot: snapshotRoot,
      pagesPerStep: 1,
    });

    try {
      assert.equal(snapshot.sourceSidecars.wal, true);
      assert.match(snapshot.sha256, /^sha256:[a-f0-9]{64}$/);
      assert.equal(snapshot.sizeBytes > 0, true);
      assert.equal(snapshot.pageCount > 0, true);
      assert.equal(
        path.dirname(snapshot.directoryPath),
        snapshotRoot,
      );
      assert.equal(
        fs.statSync(snapshot.directoryPath).mode & 0o777,
        0o700,
      );
      assert.equal(
        fs.statSync(snapshot.databasePath).mode & 0o777,
        0o600,
      );
      assert.equal(fs.existsSync(`${snapshot.databasePath}-wal`), false);
      assert.equal(fs.existsSync(`${snapshot.databasePath}-shm`), false);

      const snapshotDatabase = new Database(snapshot.databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const rowCount = snapshotDatabase
          .prepare("SELECT COUNT(*) AS count FROM events")
          .get() as { count: number };
        assert.equal(rowCount.count, 250);
      } finally {
        snapshotDatabase.close();
      }

      assert.equal(hashFile(sourcePath), sourceHashBefore);
      assert.equal(hashFile(walPath), walHashBefore);
    } finally {
      snapshot.cleanup();
      snapshot.cleanup();
      sourceDatabase.close();
    }

    assert.equal(fs.existsSync(snapshot.directoryPath), false);
  });

  it("rejects missing and invalid sources with stable safe errors", async () => {
    const root = createTemporaryDirectory();
    const snapshotRoot = path.join(root, "snapshots");
    const invalidPath = path.join(root, "invalid.db");
    fs.writeFileSync(invalidPath, "private non-SQLite content");

    await assert.rejects(
      createReadonlySqliteSnapshot(path.join(root, "missing.db"), {
        temporaryRoot: snapshotRoot,
      }),
      (error) => {
        assert.ok(error instanceof Trae2OpenCodeError);
        assert.equal(error.code, "T2O_TRAE_SQLITE_SOURCE_NOT_FOUND");
        assert.doesNotMatch(error.message, /missing\.db|private/);
        return true;
      },
    );

    await assert.rejects(
      createReadonlySqliteSnapshot(invalidPath, {
        temporaryRoot: snapshotRoot,
      }),
      (error) => {
        assert.ok(error instanceof Trae2OpenCodeError);
        assert.equal(error.code, "T2O_TRAE_SQLITE_SOURCE_INVALID");
        assert.doesNotMatch(error.message, /invalid\.db|private/);
        return true;
      },
    );
    assert.deepStrictEqual(fs.readdirSync(snapshotRoot), []);
  });

  it("rejects invalid snapshot options before creating temporary files", async () => {
    const root = createTemporaryDirectory();
    const snapshotRoot = path.join(root, "snapshots");
    const sourcePath = path.join(root, "state.vscdb");
    const sourceDatabase = createSourceDatabase(sourcePath, "delete");
    sourceDatabase.close();

    await assert.rejects(
      createReadonlySqliteSnapshot(sourcePath, {
        temporaryRoot: snapshotRoot,
        pagesPerStep: 0,
      }),
      (error) => {
        assert.ok(error instanceof Trae2OpenCodeError);
        assert.equal(error.code, "T2O_TRAE_SQLITE_SNAPSHOT_FAILED");
        return true;
      },
    );
    assert.equal(fs.existsSync(snapshotRoot), false);
  });
});

describe("withReadonlySqliteSnapshot", () => {
  it("removes the snapshot after a successful callback", async () => {
    const root = createTemporaryDirectory();
    const sourcePath = path.join(root, "state.vscdb");
    const sourceDatabase = createSourceDatabase(sourcePath, "delete");
    sourceDatabase
      .prepare("INSERT INTO events (value) VALUES (?)")
      .run("fixture");
    sourceDatabase.close();
    let directoryPath = "";

    const count = await withReadonlySqliteSnapshot(
      sourcePath,
      (snapshot) => {
        directoryPath = snapshot.directoryPath;
        const database = new Database(snapshot.databasePath, {
          readonly: true,
        });
        try {
          return (
            database
              .prepare("SELECT COUNT(*) AS count FROM events")
              .get() as { count: number }
          ).count;
        } finally {
          database.close();
        }
      },
      {
        temporaryRoot: path.join(root, "snapshots"),
      },
    );

    assert.equal(count, 1);
    assert.equal(fs.existsSync(directoryPath), false);
  });

  it("removes the snapshot when the callback fails", async () => {
    const root = createTemporaryDirectory();
    const sourcePath = path.join(root, "state.vscdb");
    const sourceDatabase = createSourceDatabase(sourcePath, "delete");
    sourceDatabase.close();
    let directoryPath = "";

    await assert.rejects(
      withReadonlySqliteSnapshot(
        sourcePath,
        (snapshot) => {
          directoryPath = snapshot.directoryPath;
          throw new Error("callback failure");
        },
        {
          temporaryRoot: path.join(root, "snapshots"),
        },
      ),
      /callback failure/,
    );
    assert.equal(fs.existsSync(directoryPath), false);
  });
});
