/** SQLite / 文件快照模块 — 只读，不修改源数据 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import type {
  FileEntry,
  SqliteSnapshot,
  SqliteTableSchema,
  JsonFileSnapshot,
  JsonKeyStructure,
} from "./types";

export function hashFileSha256(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function readSqliteSnapshot(
  absolutePath: string,
  relativePath: string,
): SqliteSnapshot {
  const sha256 = hashFileSha256(absolutePath);
  // 只读打开，直接读文件而非连接可能被写入的 WAL
  const db = new Database(absolutePath, { readonly: true, fileMustExist: true });

  const tables: SqliteTableSchema[] = [];
  try {
    const tableRows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[];

    for (const { name } of tableRows) {
      const cols = db
        .prepare(`PRAGMA table_info('${name}')`)
        .all() as SqliteTableSchema["columns"];
      const rowCount = (
        db.prepare(`SELECT COUNT(*) as cnt FROM "${name}"`).get() as {
          cnt: number;
        }
      ).cnt;

      tables.push({
        name,
        columns: cols.map((c) => ({
          cid: c.cid,
          name: c.name,
          type: c.type,
          notnull: c.notnull,
          pk: c.pk,
        })),
        rowCount,
      });
    }
  } finally {
    db.close();
  }

  return { relativePath, sha256, tables };
}

export function analyzeJsonStructure(obj: unknown, maxDepth = 10): JsonKeyStructure {
  const structure: JsonKeyStructure = {
    path: "$",
    keys: [],
    nestedKeys: {},
    arrayItemSampleKeys: [],
    maxDepth: 0,
  };

  function walk(
    val: unknown,
    currentPath: string,
    depth: number,
  ): void {
    if (depth > maxDepth) return;
    structure.maxDepth = Math.max(structure.maxDepth, depth);

    if (val === null || val === undefined) return;

    if (Array.isArray(val)) {
      // 采样第一个元素作为数组项结构
      if (val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
        structure.arrayItemSampleKeys = Object.keys(val[0] as object);
      }
      if (val.length > 0) {
        walk(val[0], `${currentPath}[0]`, depth + 1);
      }
      return;
    }

    if (typeof val === "object") {
      const keys = Object.keys(val as object);
      if (currentPath === "$") {
        structure.keys = keys;
      }
      for (const key of keys) {
        if (!structure.nestedKeys[currentPath]) {
          structure.nestedKeys[currentPath] = [];
        }
        structure.nestedKeys[currentPath].push(key);
        walk(
          (val as Record<string, unknown>)[key],
          currentPath ? `${currentPath}.${key}` : key,
          depth + 1,
        );
      }
    }
  }

  walk(obj, "$", 0);
  return structure;
}

export function readJsonSnapshot(
  absolutePath: string,
  relativePath: string,
): JsonFileSnapshot {
  const content = fs.readFileSync(absolutePath, "utf-8");
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  const parsed = JSON.parse(content);
  const structure = analyzeJsonStructure(parsed);

  return {
    relativePath,
    sha256,
    sizeBytes: Buffer.byteLength(content, "utf-8"),
    structure,
  };
}

export function scanDirectory(
  absolutePath: string,
  relativePath: string,
): { name: string; sizeBytes: number; sha256: string }[] {
  if (!fs.existsSync(absolutePath)) return [];

  const entries: { name: string; sizeBytes: number; sha256: string }[] = [];
  const dirEntries = fs.readdirSync(absolutePath, { withFileTypes: true });

  for (const entry of dirEntries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(absolutePath, entry.name);
    entries.push({
      name: entry.name,
      sizeBytes: fs.statSync(fullPath).size,
      sha256: hashFileSha256(fullPath),
    });
  }

  return entries;
}