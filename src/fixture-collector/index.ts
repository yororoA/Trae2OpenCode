/** Fixture 采集器主入口 — 编排 discovery + snapshot */

import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  discoverTraeRoots,
  listWorkspaceDirs,
} from "./discovery";
import {
  readSqliteSnapshot,
  readJsonSnapshot,
  scanDirectory,
  hashFileSha256,
} from "./snapshot";
import type {
  FixtureReport,
  CollectorOptions,
  WorkspaceSnapshot,
  ProfileFeatures,
} from "./types";

const COLLECTOR_VERSION = "0.1.2";

export function collect(options: CollectorOptions = {}): FixtureReport {
  const traeRoots = discoverTraeRoots(options.traeRoot);
  if (!traeRoots) {
    throw new Error(
      "未找到 TRAE 数据目录。请通过 --trae-root 指定路径。\n" +
        "macOS 默认：~/Library/Application Support/Trae CN/User\n" +
        "Windows 默认：%APPDATA%/Trae CN/User",
    );
  }

  // 全局 storage
  const globalStateVscdbPath = path.join(
    traeRoots.globalStoragePath,
    "state.vscdb",
  );
  const globalStateVscdb = fs.existsSync(globalStateVscdbPath)
    ? readSqliteSnapshot(globalStateVscdbPath, "globalStorage/state.vscdb")
    : null;

  // workspace storage
  const wsDirs = listWorkspaceDirs(
    traeRoots.workspaceStoragePath,
    options.maxWorkspaces,
  );

  const workspaces: WorkspaceSnapshot[] = [];

  for (const wsDir of wsDirs) {
    const wsId = path.basename(wsDir);
    const ws: WorkspaceSnapshot = {
      workspaceId: wsId,
      jsonFiles: [],
      sqliteFiles: [],
      directories: [],
      profileFeatures: {
        hasMementoStorage: false,
        hasLongText: false,
        hasPasteFiles: false,
        keyTables: [],
        workspaceJsonKeys: [],
      },
    };

    // workspace.json
    const wsJsonPath = path.join(wsDir, "workspace.json");
    if (fs.existsSync(wsJsonPath)) {
      const snap = readJsonSnapshot(wsJsonPath, `${wsId}/workspace.json`);
      ws.jsonFiles.push(snap);
      ws.profileFeatures.workspaceJsonKeys = snap.structure.keys;
    }

    // state.vscdb
    const stateVscdbPath = path.join(wsDir, "state.vscdb");
    if (fs.existsSync(stateVscdbPath)) {
      const snap = readSqliteSnapshot(stateVscdbPath, `${wsId}/state.vscdb`);
      ws.sqliteFiles.push(snap);
      ws.profileFeatures.keyTables = snap.tables.map((t) => t.name);
    }

    // long-text/
    const longTextPath = path.join(wsDir, "long-text");
    if (fs.existsSync(longTextPath)) {
      ws.profileFeatures.hasLongText = true;
      ws.directories.push({
        relativePath: `${wsId}/long-text`,
        entries: scanDirectory(longTextPath),
      });
    }

    // paste-files/
    const pasteFilesPath = path.join(wsDir, "paste-files");
    if (fs.existsSync(pasteFilesPath)) {
      ws.profileFeatures.hasPasteFiles = true;
      ws.directories.push({
        relativePath: `${wsId}/paste-files`,
        entries: scanDirectory(pasteFilesPath),
      });
    }

    // memento/icube-ai-agent-storage (旧 profile)
    const mementoPath = path.join(wsDir, "memento");
    if (fs.existsSync(mementoPath)) {
      ws.profileFeatures.hasMementoStorage = true;
      const agentStoragePath = path.join(mementoPath, "icube-ai-agent-storage");
      if (fs.existsSync(agentStoragePath)) {
        const entries = fs.readdirSync(agentStoragePath, {
          withFileTypes: true,
        });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const fullPath = path.join(agentStoragePath, entry.name);
          const ext = path.extname(entry.name);
          const relativePathHash = crypto
            .createHash("sha256")
            .update(entry.name)
            .digest("hex");
          const relPath =
            `${wsId}/memento/icube-ai-agent-storage/` +
            `${relativePathHash}${ext.toLowerCase()}`;

          if (ext.toLowerCase() === ".json") {
            try {
              ws.jsonFiles.push(readJsonSnapshot(fullPath, relPath));
            } catch {
              // 损坏的 JSON 也记录
              ws.directories.push({
                relativePath: relPath,
                entries: [
                  {
                    relativePathHash,
                    extension: ext.toLowerCase(),
                    depth: 1,
                    sizeBytes: fs.statSync(fullPath).size,
                    sha256: hashFileSha256(fullPath),
                  },
                ],
              });
            }
          }
        }
      }
    }

    workspaces.push(ws);
  }

  // profile 统计
  const profileCounts: Record<string, number> = {};
  for (const ws of workspaces) {
    const profile = buildProfileLabel(ws.profileFeatures);
    profileCounts[profile] = (profileCounts[profile] || 0) + 1;
  }

  return {
    collectorVersion: COLLECTOR_VERSION,
    collectedAt: new Date().toISOString(),
    os: traeRoots.os,
    traeRoots: {
      os: traeRoots.os,
      userDataPath: "<trae-user-data>",
      globalStoragePath: "globalStorage",
      workspaceStoragePath: "workspaceStorage",
    },
    globalStorage: { stateVscdb: globalStateVscdb },
    workspaces,
    summary: {
      totalWorkspaces: workspaces.length,
      totalSqliteFiles: workspaces.reduce(
        (s, w) => s + w.sqliteFiles.length,
        globalStateVscdb ? 1 : 0,
      ),
      totalJsonFiles: workspaces.reduce((s, w) => s + w.jsonFiles.length, 0),
      totalFileEntriesInDirs: workspaces.reduce(
        (s, w) => s + w.directories.reduce((ss, d) => ss + d.entries.length, 0),
        0,
      ),
      profileCounts,
    },
  };
}

function buildProfileLabel(features: ProfileFeatures): string {
  if (features.hasMementoStorage && features.keyTables.length === 0) {
    return "legacy-memento";
  }
  if (features.hasLongText && features.hasPasteFiles) {
    return "modern-3.x-with-attachments";
  }
  if (features.keyTables.length > 0) {
    return "modern-3.x-basic";
  }
  return "unknown";
}

export function collectToFile(options: CollectorOptions = {}): string {
  const report = collect(options);
  const outputPath =
    options.output || path.join(process.cwd(), "fixtures", "fixture-report.json");
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");
  return outputPath;
}
