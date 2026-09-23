import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  probeTraeCapabilities,
  type CapabilityField,
} from "../trae/capability-probe.js";
import type { DiscoveredTraeRoot } from "../trae/path-discovery.js";

const temporaryDirectories: string[] = [];

function createRoot(): DiscoveredTraeRoot {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "trae-capability-probe-"),
  );
  temporaryDirectories.push(root);
  const productDataPath = path.join(root, "Trae CN");
  const userDataPath = path.join(productDataPath, "User");
  const globalStoragePath = path.join(userDataPath, "globalStorage");
  const workspaceStoragePath = path.join(
    userDataPath,
    "workspaceStorage",
  );
  const modularDataPath = path.join(productDataPath, "ModularData");
  fs.mkdirSync(globalStoragePath, { recursive: true });
  fs.mkdirSync(workspaceStoragePath, { recursive: true });

  return {
    platform: "darwin",
    product: "trae-cn",
    source: "override",
    productDataPath,
    userDataPath,
    globalStoragePath,
    workspaceStoragePath,
    modularDataPath,
    availability: {
      globalStorage: true,
      workspaceStorage: true,
      modularData: false,
    },
  };
}

function createWorkspace(
  root: DiscoveredTraeRoot,
  workspaceStorageId: string,
): {
  workspacePath: string;
  projectPath: string;
} {
  const workspacePath = path.join(
    root.workspaceStoragePath,
    workspaceStorageId,
  );
  const projectPath = path.join(
    path.dirname(root.productDataPath),
    `${workspaceStorageId}-project`,
  );
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, "workspace.json"),
    JSON.stringify({
      folder: pathToFileURL(projectPath).href,
    }),
  );
  return { workspacePath, projectPath };
}

function createStateDatabase(
  workspacePath: string,
  entries: Record<string, string>,
): void {
  const database = new Database(
    path.join(workspacePath, "state.vscdb"),
  );
  try {
    database.exec(
      "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)",
    );
    const insert = database.prepare(
      "INSERT INTO ItemTable (key, value) VALUES (?, ?)",
    );
    const insertEntries = database.transaction(() => {
      for (const [key, value] of Object.entries(entries)) {
        insert.run(key, value);
      }
    });
    insertEntries();
  } finally {
    database.close();
  }
}

function fieldMap(
  fields: Array<CapabilityField<string>>,
): Record<string, CapabilityField<string>> {
  return Object.fromEntries(fields.map((field) => [field.id, field]));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("probeTraeCapabilities", () => {
  it("reports a verified v3 profile and shape-checked field coverage", async () => {
    const root = createRoot();
    const { workspacePath } = createWorkspace(root, "workspace-a");
    fs.mkdirSync(path.join(workspacePath, "long-text"));
    createStateDatabase(workspacePath, {
      "ai-chat-v2.lastActiveSessionId": "session-private",
      "chat.ChatSessionStore.index": JSON.stringify({
        entries: {},
        version: 1,
      }),
      "icube-ai-agent-storage-input-history": "[]",
      "songzhilin.irabo_AI.agent.modeListMap": "{}",
    });

    const report = await probeTraeCapabilities({
      root,
      productVersion: "3.3.104",
      temporaryRoot: path.join(
        path.dirname(root.productDataPath),
        "snapshots",
      ),
    });
    const fields = fieldMap(report.workspaces[0].fields);

    assert.equal(report.reportVersion, 1);
    assert.equal(report.discoveredWorkspaceCount, 1);
    assert.equal(report.resolvedWorkspaceCount, 1);
    assert.deepStrictEqual(report.workspaces[0].profile, {
      id: "trae-cn-workspace-v3",
      verification: "verified",
    });
    for (const fieldId of [
      "workspace-metadata",
      "project-path",
      "workspace-state",
      "active-session-id",
      "session-index",
      "input-history",
      "agent-mode-map",
      "long-text",
    ]) {
      assert.equal(fields[fieldId].status, "available");
    }
    assert.equal(fields["paste-files"].status, "missing");
    assert.equal(report.coverage["session-index"].available, 1);
    assert.deepStrictEqual(report.runtime, {
      profileId: "trae-cn-runtime-v2",
      verification: "verified",
      adapterStatus: "unavailable",
      fields: report.runtime.fields,
    });
    assert.ok(
      report.runtime.fields.every(
        (field) =>
          field.status === "requires-runtime" &&
          field.evidence === "runtime-readback",
      ),
    );
    assert.deepStrictEqual(report.issues, []);
    assert.equal(
      JSON.stringify(report).includes(
        path.dirname(root.productDataPath),
      ),
      false,
    );
  });

  it("fails closed for an unknown product version", async () => {
    const root = createRoot();
    const { workspacePath } = createWorkspace(root, "workspace-a");
    createStateDatabase(workspacePath, {
      "chat.ChatSessionStore.index": JSON.stringify({
        entries: {},
      }),
    });

    const report = await probeTraeCapabilities({
      root,
      productVersion: "3.4.0",
    });
    const fields = fieldMap(report.workspaces[0].fields);

    assert.deepStrictEqual(report.workspaces[0].profile, {
      id: "unknown",
      verification: "unsupported",
    });
    assert.equal(fields["workspace-state"].status, "unverified");
    assert.equal(fields["session-index"].status, "unverified");
    assert.equal(fields["input-history"].status, "missing");
    assert.equal(report.runtime.profileId, "unknown");
    assert.ok(
      report.runtime.fields.every(
        (field) => field.status === "unverified",
      ),
    );
  });

  it("marks an unexpected session index shape invalid", async () => {
    const root = createRoot();
    const { workspacePath } = createWorkspace(root, "workspace-a");
    createStateDatabase(workspacePath, {
      "chat.ChatSessionStore.index": JSON.stringify({
        entries: [],
      }),
    });

    const report = await probeTraeCapabilities({
      root,
      productVersion: "3.3.104",
    });
    const fields = fieldMap(report.workspaces[0].fields);

    assert.equal(fields["session-index"].status, "invalid");
  });

  it("marks a hybrid memento profile unverified", async () => {
    const root = createRoot();
    const { workspacePath } = createWorkspace(root, "workspace-a");
    createStateDatabase(workspacePath, {
      "icube-ai-agent-storage-input-history": "[]",
    });
    fs.mkdirSync(
      path.join(
        workspacePath,
        "memento",
        "icube-ai-agent-storage",
      ),
      { recursive: true },
    );

    const report = await probeTraeCapabilities({
      root,
      productVersion: "3.3.104",
    });

    assert.deepStrictEqual(report.workspaces[0].profile, {
      id: "trae-cn-hybrid",
      verification: "unverified",
    });
    assert.ok(
      report.workspaces[0].fields
        .filter((field) => field.status !== "missing")
        .every((field) => field.status === "unverified"),
    );
  });

  it("isolates missing metadata and invalid state databases", async () => {
    const root = createRoot();
    const { workspacePath } = createWorkspace(root, "workspace-b");
    fs.writeFileSync(
      path.join(workspacePath, "state.vscdb"),
      "not a sqlite database",
    );
    fs.mkdirSync(
      path.join(root.workspaceStoragePath, "workspace-a"),
    );

    const report = await probeTraeCapabilities({
      root,
      productVersion: "3.3.104",
    });
    const fields = fieldMap(report.workspaces[0].fields);

    assert.equal(report.discoveredWorkspaceCount, 2);
    assert.equal(report.resolvedWorkspaceCount, 1);
    assert.equal(fields["workspace-state"].status, "invalid");
    assert.deepStrictEqual(
      report.issues.map((issue) => [
        issue.workspaceStorageId,
        issue.code,
      ]),
      [
        ["workspace-a", "T2O_TRAE_WORKSPACE_METADATA_NOT_FOUND"],
        ["workspace-b", "T2O_TRAE_SQLITE_SOURCE_INVALID"],
      ],
    );
  });

  it("reports runtime adapter availability and probe failures", async () => {
    const root = createRoot();
    const available = await probeTraeCapabilities({
      root,
      productVersion: "3.3.104",
      runtimeProbe: () => true,
    });
    const failed = await probeTraeCapabilities({
      root,
      productVersion: "3.3.104",
      runtimeProbe() {
        throw new Error("private runtime failure");
      },
    });

    assert.equal(available.runtime.adapterStatus, "available");
    assert.ok(
      available.runtime.fields.every(
        (field) => field.status === "available",
      ),
    );
    assert.equal(failed.runtime.adapterStatus, "error");
    assert.deepStrictEqual(failed.issues, [
      {
        code: "T2O_TRAE_RUNTIME_PROBE_FAILED",
        severity: "error",
        message: "TRAE runtime capability probe failed.",
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(failed),
      /private runtime failure/,
    );
  });
});
