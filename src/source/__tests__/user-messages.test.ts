import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import type { DiscoveredTraeRoot } from "../trae/path-discovery.js";
import {
  parseTraeQueryCache,
  parseTraeRuntimeUserMessages,
  readTraeUserMessages,
} from "../trae/user-messages.js";

const temporaryDirectories: string[] = [];

function createRoot(): DiscoveredTraeRoot {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "trae-user-messages-"),
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
  inputHistory: unknown,
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
    database
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run(
        "icube-ai-agent-storage-input-history",
        JSON.stringify(inputHistory),
      );
  } finally {
    database.close();
  }
}

function runtimeUser(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    message_id: "message-user-a",
    chat_session_id: "session-runtime-a",
    role: "user",
    message_index: 1,
    created_at: 1_700_000_000,
    content: "hello",
    query: JSON.stringify(["hello"]),
    ...overrides,
  };
}

function queryCacheEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    inputText: "cached prompt",
    parsedQuery: [
      "cached prompt",
      {
        type: "file",
        path: "relative/source.ts",
      },
    ],
    multiMedia: [
      {
        resource_id: "resource-a",
        resource_type: "image",
      },
    ],
    files: [
      {
        id: "file-a",
        name: "source.ts",
        size: 42,
        type: "text/plain",
        resourceUri: "resource://file-a",
        kind: "file",
        uploadMode: "local",
        width: 100,
        height: 80,
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseTraeRuntimeUserMessages", () => {
  it("extracts structured content, preserves query data, and sorts messages", () => {
    const report = parseTraeRuntimeUserMessages(
      {
        data: {
          messages: [
            runtimeUser({
              message_id: "message-user-b",
              message_index: 3,
              created_at: 1_800_000_000,
              content: "second",
              query: JSON.stringify([
                "second",
                {
                  type: "web_page",
                  url: "https://example.test",
                },
              ]),
            }),
            {
              message_id: "message-assistant-a",
              chat_session_id: "session-runtime-a",
              role: "assistant",
              message_index: 2,
              created_at: 1_700_000_001,
            },
            runtimeUser({
              content: JSON.stringify([
                {
                  type: "text",
                  text_content: "first",
                },
                {
                  type: "image",
                  resource_id: "image-a",
                },
                {
                  type: "text",
                  text: " line",
                },
              ]),
              query: JSON.stringify([
                "first",
                {
                  type: "problem_file",
                  path: "relative/source.ts",
                },
              ]),
            }),
          ],
        },
      },
      "3.3.104",
    );

    assert.deepStrictEqual(
      report.messages.map((message) => ({
        id: message.sourceMessageId,
        order: message.order,
        text: message.text,
      })),
      [
        {
          id: "message-user-a",
          order: 1,
          text: "first line",
        },
        {
          id: "message-user-b",
          order: 3,
          text: "second",
        },
      ],
    );
    assert.deepStrictEqual(report.messages[0].query, [
      "first",
      {
        type: "problem_file",
        path: "relative/source.ts",
      },
    ]);
    assert.equal(report.messages[0].textSource.locator, "content");
    assert.equal(report.messages[0].createdAt, 1_700_000_000_000);
    assert.equal(report.messages[0].querySource?.locator, "query");
    assert.match(
      report.messages[0].sources[0].sha256,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.deepStrictEqual(report.issues, []);
  });

  it("falls back only to explicit text parts in parsed query data", () => {
    const report = parseTraeRuntimeUserMessages(
      [
        runtimeUser({
          content: JSON.stringify([
            {
              type: "image",
              resource_id: "image-a",
            },
          ]),
          query: undefined,
          user_message_context: {
            parsedQuery: [
              "fallback ",
              {
                type: "file",
                path: "relative/source.ts",
              },
              {
                type: "text",
                text: "text",
              },
            ],
          },
        }),
      ],
      "3.3.104",
    );

    assert.equal(report.messages.length, 1);
    assert.equal(report.messages[0].text, "fallback text");
    assert.equal(
      report.messages[0].textSource.locator,
      "user_message_context.parsedQuery",
    );
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      ["T2O_TRAE_USER_MESSAGE_TEXT_FROM_QUERY"],
    );
  });

  it("keeps valid content while rejecting invalid query data", () => {
    const privateQuery = "private serialized query body";
    const report = parseTraeRuntimeUserMessages(
      [
        runtimeUser({
          content: "recoverable text",
          query: privateQuery,
        }),
      ],
      "3.3.104",
    );

    assert.equal(report.messages.length, 1);
    assert.equal(report.messages[0].text, "recoverable text");
    assert.equal(report.messages[0].query, undefined);
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      ["T2O_TRAE_USER_MESSAGE_QUERY_INVALID"],
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      new RegExp(privateQuery),
    );
  });

  it("drops records without identity or recoverable text", () => {
    const report = parseTraeRuntimeUserMessages(
      [
        runtimeUser({
          message_id: "",
          content: "private invalid identity text",
        }),
        runtimeUser({
          message_id: "message-user-no-text",
          content: JSON.stringify({
            unsupported: true,
          }),
          query: JSON.stringify([
            {
              type: "file",
              path: "relative/source.ts",
            },
          ]),
        }),
      ],
      "3.3.104",
    );

    assert.deepStrictEqual(report.messages, []);
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      [
        "T2O_TRAE_USER_MESSAGE_RECORD_INVALID",
        "T2O_TRAE_USER_MESSAGE_CONTENT_INVALID",
        "T2O_TRAE_USER_MESSAGE_TEXT_MISSING",
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      /private invalid identity text|relative\/source\.ts/,
    );
  });

  it("deduplicates identical records and fails closed on conflicts", () => {
    const duplicate = runtimeUser();
    const report = parseTraeRuntimeUserMessages(
      [
        duplicate,
        { ...duplicate },
        runtimeUser({
          message_id: "message-user-conflict",
          content: "first private value",
        }),
        runtimeUser({
          message_id: "message-user-conflict",
          content: "second private value",
        }),
      ],
      "3.3.104",
    );

    assert.deepStrictEqual(
      report.messages.map((message) => message.sourceMessageId),
      ["message-user-a"],
    );
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      ["T2O_TRAE_USER_MESSAGE_DUPLICATE_CONFLICT"],
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      /first private value|second private value/,
    );
  });

  it("fails closed for an unsupported product version", () => {
    assert.throws(
      () => parseTraeRuntimeUserMessages([], "3.4.0"),
      (error) => {
        assert.ok(error instanceof Trae2OpenCodeError);
        assert.equal(
          error.code,
          "T2O_TRAE_USER_MESSAGE_VERSION_UNSUPPORTED",
        );
        return true;
      },
    );
  });
});

describe("parseTraeQueryCache", () => {
  it("normalizes supported cache fields and deduplicates by content hash", () => {
    const entry = queryCacheEntry();
    const report = parseTraeQueryCache(
      [
        entry,
        {
          files: entry.files,
          multiMedia: entry.multiMedia,
          parsedQuery: entry.parsedQuery,
          inputText: entry.inputText,
        },
      ],
      "workspace-a",
      "3.3.104",
    );

    assert.equal(report.queryCacheEntries.length, 1);
    assert.equal(report.queryCacheEntries[0].sources.length, 2);
    assert.deepStrictEqual(report.queryCacheEntries[0].multiMedia, [
      {
        resourceId: "resource-a",
        resourceType: "image",
      },
    ]);
    assert.deepStrictEqual(report.queryCacheEntries[0].files, [
      {
        id: "file-a",
        name: "source.ts",
        sizeBytes: 42,
        type: "text/plain",
        resourceUri: "resource://file-a",
        kind: "file",
        uploadMode: "local",
        width: 100,
        height: 80,
      },
    ]);
    assert.match(
      report.queryCacheEntries[0].sha256,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.deepStrictEqual(report.issues, []);
  });

  it("reports invalid entries without retaining their values", () => {
    const privateText = "private empty cache payload";
    const report = parseTraeQueryCache(
      [
        {
          inputText: privateText,
          parsedQuery: [42],
          multiMedia: [],
        },
        {
          inputText: "",
          parsedQuery: [],
          multiMedia: [],
        },
      ],
      "workspace-a",
      "3.3.104",
    );

    assert.deepStrictEqual(report.queryCacheEntries, []);
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.entryIndex),
      [0, 1],
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      new RegExp(privateText),
    );
  });
});

describe("readTraeUserMessages", () => {
  it("reads runtime messages and deduplicates cache sources across workspaces", async () => {
    const root = createRoot();
    const cached = queryCacheEntry();
    createWorkspaceState(root, "workspace-b", [cached]);
    createWorkspaceState(root, "workspace-a", [
      {
        files: cached.files,
        multiMedia: cached.multiMedia,
        parsedQuery: cached.parsedQuery,
        inputText: cached.inputText,
      },
    ]);
    const requests: string[] = [];
    const privateProviderError =
      "/Users/private/project private provider payload";

    const report = await readTraeUserMessages({
      root,
      productVersion: "3.3.104",
      sourceSessionIds: [
        "session-runtime-b",
        "session-runtime-a",
        "session-runtime-a",
      ],
      runtimeMessageProvider({ sourceSessionId }) {
        requests.push(sourceSessionId);
        if (sourceSessionId === "session-runtime-b") {
          throw new Error(privateProviderError);
        }
        return {
          messages: [
            runtimeUser({
              content: "runtime text",
            }),
            runtimeUser({
              message_id: "message-wrong-session",
              chat_session_id: "session-runtime-other",
              content: "wrong session private text",
            }),
          ],
        };
      },
      temporaryRoot: path.join(
        path.dirname(root.productDataPath),
        "snapshots",
      ),
    });

    assert.deepStrictEqual(requests, [
      "session-runtime-a",
      "session-runtime-b",
    ]);
    assert.deepStrictEqual(
      report.messages.map((message) => message.sourceMessageId),
      ["message-user-a"],
    );
    assert.equal(report.queryCacheEntries.length, 1);
    assert.deepStrictEqual(
      report.queryCacheEntries[0].sources.map(
        (source) => source.workspaceStorageId,
      ),
      ["workspace-a", "workspace-b"],
    );
    assert.deepStrictEqual(report.sourceCounts, {
      "runtime-user-message": 1,
      "workspace-query-cache": 2,
    });
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.code ===
          "T2O_TRAE_USER_MESSAGE_PROVIDER_FAILED",
      ),
    );
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.code === "T2O_TRAE_USER_MESSAGE_RECORD_INVALID" &&
          issue.sourceMessageId === "message-wrong-session",
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      /\/Users\/private|private provider payload|wrong session private text/,
    );
  });

  it("isolates unreadable workspace state databases", async () => {
    const root = createRoot();
    const workspacePath = path.join(
      root.workspaceStoragePath,
      "workspace-invalid",
    );
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "state.vscdb"),
      "private invalid database body",
    );

    const report = await readTraeUserMessages({
      root,
      productVersion: "3.3.104",
      sourceSessionIds: [],
    });

    assert.deepStrictEqual(report.messages, []);
    assert.deepStrictEqual(report.queryCacheEntries, []);
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      ["T2O_TRAE_QUERY_CACHE_READ_FAILED"],
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      /private invalid database body|\/Users\//,
    );
  });
});
