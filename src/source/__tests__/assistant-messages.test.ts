import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  parseTraeRuntimeAssistantMessages,
  readTraeAssistantMessages,
  scanTraeLongTextResources,
} from "../trae/assistant-messages.js";
import type { DiscoveredTraeRoot } from "../trae/path-discovery.js";
import { parseTraeQueryCache } from "../trae/user-messages.js";

const temporaryDirectories: string[] = [];

function createRoot(): DiscoveredTraeRoot {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "trae-assistant-messages-"),
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

function runtimeAssistant(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    message_id: "message-assistant-a",
    chat_session_id: "session-runtime-a",
    turn_id: "turn-runtime-a",
    reply_to_message_id: "message-user-a",
    role: "assistant",
    message_type: "general",
    message_index: 2,
    created_at: 1_700_000_000,
    chat_start_time: 1_700_000_000_100,
    chat_end_time: 1_700_000_000_900,
    status: "completed",
    content: JSON.stringify({
      content: "assistant response",
      reasoning_content: "private reasoning",
    }),
    ...overrides,
  };
}

function createLongText(
  root: DiscoveredTraeRoot,
  workspaceStorageId: string,
  relativePath: string,
  content: string | Buffer,
): string {
  const absolutePath = path.join(
    root.workspaceStoragePath,
    workspaceStorageId,
    "long-text",
    relativePath,
  );
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
  return absolutePath;
}

function queryCache(
  workspaceStorageId: string,
  parsedQuery: unknown[],
) {
  return parseTraeQueryCache(
    [
      {
        inputText: "cached prompt",
        parsedQuery,
        multiMedia: [],
        files: [],
      },
    ],
    workspaceStorageId,
    "3.3.104",
  ).queryCacheEntries;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseTraeRuntimeAssistantMessages", () => {
  it("maps general assistant text, relations, status, and timing", () => {
    const report = parseTraeRuntimeAssistantMessages(
      {
        data: {
          messages: [
            runtimeAssistant({
              message_id: "message-assistant-b",
              message_index: 4,
              created_at: 1_800_000_000,
              status: "in_progress",
              chat_end_time: undefined,
              content: JSON.stringify({
                content: "second response",
              }),
            }),
            {
              role: "user",
              message_id: "message-user-a",
            },
            runtimeAssistant(),
          ],
        },
      },
      "3.3.104",
    );

    assert.deepStrictEqual(
      report.messages.map((message) => ({
        id: message.sourceMessageId,
        order: message.order,
        status: message.status,
        text: message.textBlocks.map((block) => block.text),
      })),
      [
        {
          id: "message-assistant-a",
          order: 2,
          status: "completed",
          text: ["assistant response"],
        },
        {
          id: "message-assistant-b",
          order: 4,
          status: "in-progress",
          text: ["second response"],
        },
      ],
    );
    assert.equal(report.messages[0].createdAt, 1_700_000_000_000);
    assert.equal(report.messages[0].startedAt, 1_700_000_000_100);
    assert.equal(report.messages[0].completedAt, 1_700_000_000_900);
    assert.equal(report.messages[0].turnId, "turn-runtime-a");
    assert.equal(report.messages[0].replyToMessageId, "message-user-a");
    assert.equal(
      report.messages[0].textBlocks[0].source.locator,
      "content.content",
    );
    assert.doesNotMatch(
      JSON.stringify(report.messages[0].textBlocks),
      /private reasoning/,
    );
    assert.equal(report.messages[0].reasoningBlocks[0].text, "private reasoning");
    assert.deepStrictEqual(report.issues, []);
  });

  it("preserves proposal text order without mapping plan reasoning", () => {
    const report = parseTraeRuntimeAssistantMessages(
      [
        runtimeAssistant({
          message_type: "task",
          agent_type: "agent",
          content: JSON.stringify({
            messages: [
              {
                type: "proposal",
                proposal: {
                  content: {
                    thought: "first proposal",
                    reasoning_content: "private proposal reasoning",
                  },
                },
              },
              {
                type: "plan_item",
                plan_item: {
                  id: "plan-proposal-a",
                  thought: "private plan thought",
                  reasoning_content: "private plan reasoning",
                },
              },
              {
                type: "proposal",
                proposal: {
                  content: {
                    thought: "second proposal",
                  },
                },
              },
            ],
          }),
        }),
      ],
      "3.3.104",
    );

    assert.deepStrictEqual(
      report.messages[0].textBlocks.map((block) => block.text),
      ["first proposal", "second proposal"],
    );
    assert.doesNotMatch(
      JSON.stringify(report.messages[0].textBlocks),
      /private proposal reasoning|private plan thought|private plan reasoning/,
    );
    assert.deepEqual(report.messages[0].reasoningBlocks.map((block) => block.text),
      ["private proposal reasoning", "private plan reasoning"]);
    assert.deepEqual(report.issues.map((issue) => issue.code), ["T2O_TRAE_PLAN_THOUGHT_UNMAPPED"]);
    assert.doesNotMatch(JSON.stringify(report.issues), /private proposal reasoning|private plan thought|private plan reasoning/);
  });

  it("uses chat plan thought and lets an explicit response summary override it", () => {
    const report = parseTraeRuntimeAssistantMessages(
      [
        runtimeAssistant({
          message_type: "task",
          agent_type: "chat",
          content: {
            messages: [
              {
                type: "plan_item",
                plan_item: {
                  id: "plan-chat-a",
                  thought: "initial visible response",
                  reasoning_content: "private reasoning",
                },
              },
              {
                type: "plan_item",
                plan_item: {
                  id: "plan-chat-b",
                  thought: "later plan thought",
                  tool_call_info: {
                    name: "response_to_user",
                    params: JSON.stringify({
                      summary: "final response",
                    }),
                  },
                },
              },
            ],
          },
        }),
      ],
      "3.3.104",
    );

    assert.deepStrictEqual(
      report.messages[0].textBlocks.map((block) => block.text),
      ["final response"],
    );
    assert.equal(
      report.messages[0].textBlocks[0].source.locator,
      "content.messages[1].plan_item.tool_call_info.params.summary",
    );
    assert.doesNotMatch(
      JSON.stringify(report.messages[0].textBlocks),
      /initial visible response|later plan thought|private reasoning/,
    );

    const firstPlanItemIsAuthoritative =
      parseTraeRuntimeAssistantMessages(
        [
          runtimeAssistant({
            message_type: "task",
            agent_type: "chat",
            content: {
              messages: [
                {
                  type: "plan_item",
                  plan_item: { id: "plan-chat-a", thought: "" },
                },
                {
                  type: "plan_item",
                  plan_item: { id: "plan-chat-b", thought: "later private thought" },
                },
              ],
            },
          }),
        ],
        "3.3.104",
      );
    assert.deepStrictEqual(
      firstPlanItemIsAuthoritative.messages[0].textBlocks,
      [],
    );
    assert.doesNotMatch(
      JSON.stringify(firstPlanItemIsAuthoritative.issues),
      /later private thought/,
    );
  });

  it("retains valid metadata when no assistant text can be mapped", () => {
    const report = parseTraeRuntimeAssistantMessages(
      [
        runtimeAssistant({
          content: JSON.stringify({
            reasoning_content: "private reasoning only",
          }),
        }),
      ],
      "3.3.104",
    );

    assert.equal(report.messages.length, 1);
    assert.deepStrictEqual(report.messages[0].textBlocks, []);
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      ["T2O_TRAE_ASSISTANT_MESSAGE_TEXT_MISSING"],
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      /private reasoning only/,
    );
  });

  it("projects the verified lowercase finish summary", () => {
    const report = parseTraeRuntimeAssistantMessages([runtimeAssistant({
      message_type: "task",
      agent_type: "chat",
      content: { messages: [{
        type: "plan_item",
        plan_item: {
          id: "plan-finish",
          tool_call_info: { name: "finish", params: { summary: "final answer" } },
        },
      }] },
    })], "3.3.104");
    assert.deepEqual(report.messages[0].textBlocks.map((block) => block.text), ["final answer"]);
  });

  it("projects the verified solo agent finish summary", () => {
    const report = parseTraeRuntimeAssistantMessages([runtimeAssistant({
      message_type: "task",
      agent_type: "solo_agent",
      content: { messages: [{
        type: "plan_item",
        plan_item: {
          id: "plan-solo-finish",
          thought: "internal plan thought",
          tool_call_info: { name: "finish", params: { summary: "visible solo answer" } },
        },
      }] },
    })], "3.3.104");
    assert.deepEqual(report.messages[0].textBlocks.map((block) => block.text),
      ["visible solo answer"]);
    assert.doesNotMatch(JSON.stringify(report.messages[0].textBlocks), /internal plan thought/);
  });

  it("isolates invalid timing and status without leaking content", () => {
    const privateContent = "private assistant response";
    const report = parseTraeRuntimeAssistantMessages(
      [
        runtimeAssistant({
          status: "future_status",
          chat_start_time: "not-a-timestamp",
          chat_end_time: "also-invalid",
          content: JSON.stringify({ content: privateContent }),
        }),
        runtimeAssistant({
          message_id: "",
          content: JSON.stringify({
            content: "private invalid identity text",
          }),
        }),
      ],
      "3.3.104",
    );

    assert.equal(report.messages.length, 1);
    assert.equal(report.messages[0].status, "unknown");
    assert.equal(report.messages[0].startedAt, undefined);
    assert.equal(report.messages[0].completedAt, undefined);
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      [
        "T2O_TRAE_ASSISTANT_MESSAGE_STATUS_INVALID",
        "T2O_TRAE_ASSISTANT_MESSAGE_TIMING_INVALID",
        "T2O_TRAE_ASSISTANT_MESSAGE_TIMING_INVALID",
        "T2O_TRAE_ASSISTANT_MESSAGE_RECORD_INVALID",
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      /private assistant response|private invalid identity text|not-a-timestamp/,
    );
  });

  it("does not synthesize missing or reversed completion timing", () => {
    const report = parseTraeRuntimeAssistantMessages(
      [
        runtimeAssistant({
          message_id: "message-missing-end",
          chat_end_time: undefined,
        }),
        runtimeAssistant({
          message_id: "message-reversed-end",
          message_index: 4,
          chat_start_time: 1_700_000_001_000,
          chat_end_time: 1_700_000_000_500,
        }),
      ],
      "3.3.104",
    );

    assert.equal(report.messages.length, 2);
    assert.deepStrictEqual(
      report.messages.map((message) => message.completedAt),
      [undefined, undefined],
    );
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      [
        "T2O_TRAE_ASSISTANT_MESSAGE_COMPLETION_TIME_MISSING",
        "T2O_TRAE_ASSISTANT_MESSAGE_TIMING_ORDER_INVALID",
        "T2O_TRAE_ASSISTANT_MESSAGE_COMPLETION_TIME_MISSING",
      ],
    );
  });

  it("fails closed on duplicate conflicts and unsupported versions", () => {
    const duplicate = runtimeAssistant();
    const report = parseTraeRuntimeAssistantMessages(
      [
        duplicate,
        { ...duplicate },
        runtimeAssistant({
          message_id: "message-conflict",
          content: JSON.stringify({ content: "private first" }),
        }),
        runtimeAssistant({
          message_id: "message-conflict",
          content: JSON.stringify({ content: "private second" }),
        }),
      ],
      "3.3.104",
    );

    assert.deepStrictEqual(
      report.messages.map((message) => message.sourceMessageId),
      ["message-assistant-a"],
    );
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      ["T2O_TRAE_ASSISTANT_MESSAGE_DUPLICATE_CONFLICT"],
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      /private first|private second/,
    );
    assert.throws(
      () => parseTraeRuntimeAssistantMessages([], "3.4.0"),
      (error) => {
        assert.ok(error instanceof Trae2OpenCodeError);
        assert.equal(
          error.code,
          "T2O_TRAE_ASSISTANT_MESSAGE_VERSION_UNSUPPORTED",
        );
        return true;
      },
    );
  });
});

describe("scanTraeLongTextResources", () => {
  it("refuses symlink roots and excessive directory depth", () => {
    const root = createRoot();
    const file = createLongText(root, "workspace-a", "scope/entry/file.txt", "outside workspace body");
    const secondWorkspace = path.join(root.workspaceStoragePath, "workspace-b");
    fs.mkdirSync(secondWorkspace);
    fs.symlinkSync(path.dirname(path.dirname(path.dirname(file))), path.join(secondWorkspace, "long-text"), "dir");
    createLongText(root, "workspace-a", "scope/entry/deeper/file.txt", "unsupported depth");
    const report = scanTraeLongTextResources(root, "3.3.104");
    assert.equal(report.longTextResources.length, 1);
    assert.equal(report.longTextResources[0].workspaceStorageId, "workspace-a");
    assert.equal(report.issues.filter((item) => item.code === "T2O_TRAE_LONG_TEXT_LAYOUT_INVALID").length, 2);
    assert.doesNotMatch(JSON.stringify(report), /outside workspace body|unsupported depth/);
  });

  it("associates only exact query-cache paths in the same workspace", () => {
    const root = createRoot();
    const firstPath = createLongText(
      root,
      "workspace-a",
      path.join("scope-a", "entry1234567", "first.txt"),
      "first long text",
    );
    const secondPath = createLongText(
      root,
      "workspace-a",
      path.join("scope-a", "entry1234568", "second.txt"),
      "second long text",
    );
    const entries = queryCache("workspace-a", [
      {
        type: "long_text",
        filePath: firstPath,
      },
      {
        type: "related_long_text",
        relatePath: pathToFileURL(secondPath).href,
      },
    ]);

    const report = scanTraeLongTextResources(
      root,
      "3.3.104",
      entries,
    );

    assert.equal(report.longTextResources.length, 2);
    assert.deepStrictEqual(
      report.longTextResources.map((resource) => ({
        relativePath: resource.relativePath,
        references: resource.references.length,
      })),
      [
        {
          relativePath: path.join(
            "scope-a",
            "entry1234567",
            "first.txt",
          ),
          references: 1,
        },
        {
          relativePath: path.join(
            "scope-a",
            "entry1234568",
            "second.txt",
          ),
          references: 1,
        },
      ],
    );
    assert.deepStrictEqual(report.issues, []);
    assert.match(
      report.longTextResources[0].contentSha256,
      /^sha256:[a-f0-9]{64}$/,
    );
  });

  it("never falls back to basename or scope matching", () => {
    const root = createRoot();
    createLongText(
      root,
      "workspace-a",
      path.join("scope-a", "entry1234567", "same.txt"),
      "first private long text",
    );
    createLongText(
      root,
      "workspace-a",
      path.join("scope-b", "entry1234568", "same.txt"),
      "second private long text",
    );
    const entries = queryCache("workspace-a", [
      {
        filePath: "same.txt",
      },
    ]);

    const report = scanTraeLongTextResources(
      root,
      "3.3.104",
      entries,
    );

    assert.deepStrictEqual(
      report.longTextResources.map(
        (resource) => resource.references.length,
      ),
      [0, 0],
    );
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      [
        "T2O_TRAE_LONG_TEXT_UNASSOCIATED",
        "T2O_TRAE_LONG_TEXT_UNASSOCIATED",
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      /same\.txt|first private long text|second private long text|\/Users\//,
    );
  });

  it("rejects a query-cache path that crosses workspace ownership", () => {
    const root = createRoot();
    const otherWorkspacePath = createLongText(
      root,
      "workspace-b",
      path.join("scope-b", "entry1234567", "other.txt"),
      "other workspace private text",
    );
    const entries = queryCache("workspace-a", [
      {
        filePath: otherWorkspacePath,
      },
    ]);

    const report = scanTraeLongTextResources(
      root,
      "3.3.104",
      entries,
    );

    assert.equal(report.longTextResources.length, 1);
    assert.deepStrictEqual(
      report.longTextResources[0].references,
      [],
    );
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      [
        "T2O_TRAE_LONG_TEXT_REFERENCE_INVALID",
        "T2O_TRAE_LONG_TEXT_UNASSOCIATED",
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      /workspace private text|other\.txt|\/Users\//,
    );
  });

  it("reports missing references, invalid layouts, and invalid UTF-8 safely", () => {
    const root = createRoot();
    createLongText(
      root,
      "workspace-a",
      path.join("scope-a", "entry1234567", "valid.txt"),
      "valid private long text",
    );
    createLongText(
      root,
      "workspace-a",
      path.join("unsupported-depth", "invalid.txt"),
      "invalid layout body",
    );
    createLongText(
      root,
      "workspace-a",
      path.join("scope-b", "entry1234568", "invalid.txt"),
      Buffer.from([0xc3, 0x28]),
    );
    const entries = queryCache("workspace-a", [
      {
        relatePath: path.join(
          "long-text",
          "scope-a",
          "entry1234569",
          "missing.txt",
        ),
      },
    ]);

    const report = scanTraeLongTextResources(
      root,
      "3.3.104",
      entries,
    );

    assert.equal(report.longTextResources.length, 1);
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code).sort(),
      [
        "T2O_TRAE_LONG_TEXT_LAYOUT_INVALID",
        "T2O_TRAE_LONG_TEXT_READ_FAILED",
        "T2O_TRAE_LONG_TEXT_REFERENCE_MISSING",
        "T2O_TRAE_LONG_TEXT_UNASSOCIATED",
      ].sort(),
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      /valid\.txt|invalid\.txt|missing\.txt|private long text|\/Users\//,
    );
  });
});

describe("readTraeAssistantMessages", () => {
  it("isolates providers and composes runtime and long-text counts", async () => {
    const root = createRoot();
    const resourcePath = createLongText(
      root,
      "workspace-a",
      path.join("scope-a", "entry1234567", "response.txt"),
      "private long text",
    );
    const requests: string[] = [];
    const privateProviderError =
      "/Users/private/project private provider payload";

    const report = await readTraeAssistantMessages({
      root,
      productVersion: "3.3.104",
      sourceSessionIds: [
        "session-runtime-b",
        "session-runtime-a",
        "session-runtime-a",
      ],
      longTextReferences: [
        {
          workspaceStorageId: "workspace-a",
          path: resourcePath,
          sourceSessionId: "session-runtime-a",
          sourceMessageId: "message-assistant-a",
        },
      ],
      runtimeMessageProvider({ sourceSessionId }) {
        requests.push(sourceSessionId);
        if (sourceSessionId === "session-runtime-b") {
          throw new Error(privateProviderError);
        }
        return [
          runtimeAssistant(),
          runtimeAssistant({
            message_id: "message-wrong-session",
            chat_session_id: "session-runtime-other",
            content: JSON.stringify({
              content: "wrong session private text",
            }),
          }),
        ];
      },
    });

    assert.deepStrictEqual(requests, [
      "session-runtime-a",
      "session-runtime-b",
    ]);
    assert.deepStrictEqual(
      report.messages.map((message) => message.sourceMessageId),
      ["message-assistant-a"],
    );
    assert.equal(report.longTextResources.length, 1);
    assert.deepStrictEqual(report.sourceCounts, {
      "runtime-assistant-message": 1,
      "workspace-long-text": 1,
      "workspace-query-cache-reference": 0,
      "explicit-long-text-reference": 1,
    });
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      [
        "T2O_TRAE_ASSISTANT_MESSAGE_RECORD_INVALID",
        "T2O_TRAE_ASSISTANT_MESSAGE_PROVIDER_FAILED",
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(report.issues),
      /\/Users\/private|private provider payload|wrong session private text|response\.txt/,
    );
  });
});
