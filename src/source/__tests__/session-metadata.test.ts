import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import type { DiscoveredTraeRoot } from "../trae/path-discovery.js";
import {
  parseTraeRuntimeSessionMetadata,
  readTraeSessionMetadata,
} from "../trae/session-metadata.js";

const temporaryDirectories: string[] = [];

function createRoot(): DiscoveredTraeRoot {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "trae-session-metadata-"),
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
  fs.mkdirSync(modularDataPath, { recursive: true });

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
      modularData: true,
    },
  };
}

function createWorkspaceState(
  root: DiscoveredTraeRoot,
  workspaceStorageId: string,
  values: Record<string, string>,
): void {
  const workspacePath = path.join(
    root.workspaceStoragePath,
    workspaceStorageId,
  );
  fs.mkdirSync(workspacePath, { recursive: true });
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
    for (const [key, value] of Object.entries(values)) {
      insert.run(key, value);
    }
  } finally {
    database.close();
  }
}

function createSnapshotSession(
  root: DiscoveredTraeRoot,
  sourceSessionId: string,
): void {
  fs.mkdirSync(
    path.join(
      root.modularDataPath,
      "ai-agent",
      "snapshot",
      sourceSessionId,
      "v2",
    ),
    { recursive: true },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseTraeRuntimeSessionMetadata", () => {
  it("normalizes the local get_sessions timestamp contract", () => {
    const report = parseTraeRuntimeSessionMetadata(
      {
        sessions: [
          {
            session_id: "session-local-a",
            name: "Local session",
            created_at: "1_700_000_000".replaceAll("_", ""),
            update_at: 1_700_000_100,
          },
        ],
      },
      "3.3.104",
    );

    assert.deepStrictEqual(report.issues, []);
    assert.deepStrictEqual(
      report.sessions.map((session) => ({
        sourceSessionId: session.sourceSessionId,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        metadataStatus: session.metadataStatus,
      })),
      [
        {
          sourceSessionId: "session-local-a",
          title: "Local session",
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_100_000,
          metadataStatus: "complete",
        },
      ],
    );
  });

  it("normalizes V2 metadata and sorts sessions deterministically", () => {
    const report = parseTraeRuntimeSessionMetadata(
      {
        items: [
          {
            chat_session_id: "session-v2-older",
            title: "Older",
            created_at: "2026-09-20T10:00:00.000Z",
            updated_at: "2026-09-20T11:00:00.000Z",
          },
          {
            chat_session_id: "session-v2-newer",
            title: "Newer",
            created_at: 2_000_000_000_000,
            updated_at: 2_000_000_100_000,
            parent_session_id: "session-v2-older",
          },
        ],
      },
      "3.3.104",
    );

    assert.deepStrictEqual(
      report.sessions.map((session) => session.sourceSessionId),
      ["session-v2-newer", "session-v2-older"],
    );
    assert.equal(
      report.sessions[0].parentSourceId,
      "session-v2-older",
    );
    assert.match(
      report.sessions[0].sources[0].sha256,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.deepStrictEqual(report.issues, []);
  });

  it("reports missing metadata without synthesizing values", () => {
    const report = parseTraeRuntimeSessionMetadata(
      [{ chat_session_id: "session-missing" }],
      "3.3.104",
    );

    assert.deepStrictEqual(report.sessions, [
      {
        sourceSessionId: "session-missing",
        workspaceStorageIds: [],
        metadataStatus: "partial",
        sources: report.sessions[0].sources,
      },
    ]);
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      [
        "T2O_TRAE_SESSION_TITLE_MISSING",
        "T2O_TRAE_SESSION_CREATED_AT_MISSING",
        "T2O_TRAE_SESSION_UPDATED_AT_MISSING",
      ],
    );
  });

  it("marks invalid timestamps and conflicting metadata invalid", () => {
    const report = parseTraeRuntimeSessionMetadata(
      [
        {
          chat_session_id: "session-conflict",
          title: "First title",
          created_at: "invalid",
          updated_at: 100,
        },
        {
          chat_session_id: "session-conflict",
          title: "Second title",
          created_at: 200,
          updated_at: 100,
        },
      ],
      "3.3.104",
    );

    assert.equal(report.sessions.length, 1);
    assert.equal(report.sessions[0].metadataStatus, "invalid");
    assert.equal(report.sessions[0].title, undefined);
    assert.deepStrictEqual(
      [...new Set(report.issues.map((issue) => issue.code))].sort(),
      [
        "T2O_TRAE_SESSION_METADATA_CONFLICT",
        "T2O_TRAE_SESSION_TIMESTAMP_INVALID",
        "T2O_TRAE_SESSION_TIMESTAMP_ORDER_INVALID",
        "T2O_TRAE_SESSION_TITLE_MISSING",
      ],
    );
  });

  it("fails closed for an unsupported product version", () => {
    assert.throws(
      () => parseTraeRuntimeSessionMetadata([], "3.4.0"),
      (error) => {
        assert.ok(error instanceof Trae2OpenCodeError);
        assert.equal(
          error.code,
          "T2O_TRAE_SESSION_INDEX_VERSION_UNSUPPORTED",
        );
        return true;
      },
    );
  });
});

describe("readTraeSessionMetadata", () => {
  it("discovers local candidates and enriches them through a runtime provider", async () => {
    const root = createRoot();
    createWorkspaceState(root, "workspace-a", {
      "ai-chat-v2.lastActiveSessionId": "session-runtime-b",
      "chat.ChatSessionStore.index": JSON.stringify({
        version: 1,
        entries: {
          "session-runtime-a": {
            sessionId: "session-runtime-a",
            title: "Cached title",
            lastMessageDate: 2_000,
            timing: {
              startTime: 1_000,
              endTime: 2_000,
            },
          },
        },
      }),
    });
    createSnapshotSession(root, "session-runtime-b");
    createSnapshotSession(root, "session-snapshot-c");
    fs.mkdirSync(
      path.join(
        root.modularDataPath,
        "ai-agent",
        "snapshot",
        "bad",
      ),
      { recursive: true },
    );
    const providerRequests: string[][] = [];

    const report = await readTraeSessionMetadata({
      root,
      productVersion: "3.3.104",
      runtimeMetadataProvider({ sourceSessionIds }) {
        providerRequests.push([...sourceSessionIds]);
        return {
          items: [
            {
              chat_session_id: "session-runtime-a",
              title: "Current title",
              created_at: 3_000,
              updated_at: 4_000,
            },
            {
              chat_session_id: "session-runtime-b",
              title: "Second session",
              created_at: 5_000,
              updated_at: 6_000,
            },
            {
              chat_session_id: "session-not-requested",
              title: "Ignored",
              created_at: 1,
              updated_at: 2,
            },
          ],
        };
      },
      temporaryRoot: path.join(
        path.dirname(root.productDataPath),
        "snapshots",
      ),
    });

    assert.deepStrictEqual(providerRequests, [
      [
        "session-runtime-a",
        "session-runtime-b",
        "session-snapshot-c",
      ],
    ]);
    assert.deepStrictEqual(
      report.sessions.map((session) => ({
        id: session.sourceSessionId,
        title: session.title,
        status: session.metadataStatus,
      })),
      [
        {
          id: "session-runtime-b",
          title: "Second session",
          status: "complete",
        },
        {
          id: "session-runtime-a",
          title: "Current title",
          status: "complete",
        },
        {
          id: "session-snapshot-c",
          title: undefined,
          status: "partial",
        },
      ],
    );
    assert.deepStrictEqual(report.sourceCounts, {
      "runtime-metadata": 2,
      "snapshot-directory": 2,
      "workspace-active-session": 1,
      "workspace-session-index": 1,
    });
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.code === "T2O_TRAE_SESSION_INDEX_RECORD_INVALID" &&
          issue.sourceSessionId === "session-not-requested",
      ),
    );
    assert.equal(
      JSON.stringify(report).includes(root.productDataPath),
      false,
    );
  });

  it("isolates provider failures and does not expose their messages", async () => {
    const root = createRoot();
    createSnapshotSession(root, "session-provider-failure");
    const privateError = "/Users/private/project secret payload";

    const report = await readTraeSessionMetadata({
      root,
      productVersion: "3.3.104",
      runtimeMetadataProvider() {
        throw new Error(privateError);
      },
    });
    const serialized = JSON.stringify(report);

    assert.equal(report.sessions.length, 1);
    assert.equal(report.sessions[0].metadataStatus, "partial");
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.code ===
          "T2O_TRAE_SESSION_METADATA_PROVIDER_FAILED",
      ),
    );
    assert.doesNotMatch(serialized, /private|secret|\/Users\//);
  });
});
