import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createTraeParser } from "../trae/parser-registry.js";
import type { DiscoveredTraeRoot } from "../trae/path-discovery.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("createTraeParser", () => {
  it("dispatches runtime metadata, user, assistant, reasoning and tools with a bound version", () => {
    const selection = { productVersion: "3.3.104", profileId: "trae-cn-runtime-v2", profileVersion: 1 };
    const parser = createTraeParser(selection);
    assert.equal(parser.kind, "runtime");
    if (parser.kind !== "runtime") throw new Error("Expected runtime parser");
    // Mutating a caller's options after resolution must not change parser identity.
    selection.productVersion = "unknown";
    const raw = {
      messages: [
        { role: "user", message_id: "user-a", chat_session_id: "session-a", message_index: 1, created_at: 100, content: "question" },
        {
          role: "assistant", message_id: "assistant-a", chat_session_id: "session-a",
          message_index: 2, created_at: 100, message_type: "general",
          turn_id: "turn-a", reply_to_message_id: "user-a", status: "completed", chat_end_time: 101_000,
          content: { content: "answer", reasoning_content: "reason" },
        },
      ],
    };
    const metadata = parser.parseSessionMetadata([{ session_id: "session-a", title: "Example", created_at: 100, updated_at: 101 }]);
    assert.equal(metadata.sessions[0].sourceSessionId, "session-a");
    const users = parser.parseUserMessages(raw);
    assert.equal(users.messages[0].text, "question");
    assert.equal(users.messages[0].createdAt, 100_000);
    const assistants = parser.parseAssistantMessages(raw);
    assert.equal(assistants.messages[0].textBlocks[0].text, "answer");
    assert.equal(assistants.messages[0].reasoningBlocks[0].text, "reason");
    assert.equal(assistants.messages[0].completedAt, 101_000);
    assert.equal(parser.parseReasoningPlan({ reasoning_content: "reason" }, "general").reasoningBlocks[0].text, "reason");
    const tools = parser.parseToolCalls({
      messages: [{
        type: "plan_item",
        plan_item: { id: "plan-a", tool_call_info: { id: "call-a", name: "Read", params: { path: "a.ts" }, result: { status: "success", data: "output" } } },
      }],
    }, "task");
    assert.equal(tools.toolCalls[0].output, "output");
    assert.equal(tools.toolCalls[0].status, "completed");
    assert.equal("scanResources" in parser, false);
    assert.equal("adapterStatus" in parser, false);
    assert.equal(Reflect.set(parser, "kind", "workspace"), false);
  });

  it("dispatches workspace cache and exact resource scans without exposing runtime parsers", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "trae-registry-"));
    temporaryDirectories.push(base);
    const workspaceStoragePath = path.join(base, "User", "workspaceStorage");
    const longTextPath = path.join(workspaceStoragePath, "workspace-a", "long-text", "scope", "entry", "a.txt");
    fs.mkdirSync(path.dirname(longTextPath), { recursive: true });
    fs.writeFileSync(longTextPath, "long text");
    const root: DiscoveredTraeRoot = {
      platform: "darwin", product: "trae-cn", source: "override", productDataPath: base,
      userDataPath: path.join(base, "User"), workspaceStoragePath,
      globalStoragePath: path.join(base, "User", "globalStorage"), modularDataPath: path.join(base, "ModularData"),
      availability: { workspaceStorage: true, globalStorage: false, modularData: false },
    };
    const parser = createTraeParser({ productVersion: "3.3.104", profileId: "trae-cn-workspace-v3", profileVersion: 1 });
    assert.equal(parser.kind, "workspace");
    if (parser.kind !== "workspace") throw new Error("Expected workspace parser");
    const cache = parser.parseQueryCache([{
      inputText: "question", parsedQuery: ["question"], files: [], multiMedia: [],
    }], "workspace-a");
    assert.equal(cache.queryCacheEntries[0].inputText, "question");
    assert.equal(cache.queryCacheEntries[0].sources[0].workspaceStorageId, "workspace-a");
    assert.equal(parser.scanLongText(root).longTextResources.length, 1);
    const resources = parser.scanResources(root, cache.queryCacheEntries, [{
      workspaceStorageId: "workspace-a", path: "long-text/scope/entry/a.txt", sourceSessionId: "session-a",
    }]);
    assert.equal(resources.resources[0].availability, "available");
    assert.equal(resources.resources[0].references[0].sourceSessionId, "session-a");
    const metadata = await parser.readSessionMetadata({ root });
    assert.deepStrictEqual(metadata.sessions, []);
    assert.equal("parseUserMessages" in parser, false);
    assert.equal("parseAssistantMessages" in parser, false);
  });

  it("rejects unverified and unknown selections before exposing a parser", () => {
    for (const [profileId, code] of [
      ["trae-cn-memento-v1", "T2O_TRAE_PROFILE_UNVERIFIED"],
      ["trae-cn-hybrid", "T2O_TRAE_PROFILE_UNVERIFIED"],
      ["renderer-log", "T2O_TRAE_PROFILE_UNKNOWN"],
      ["direct-database", "T2O_TRAE_PROFILE_UNKNOWN"],
    ]) {
      assert.throws(() => createTraeParser({ productVersion: "3.3.104", profileId, profileVersion: 1 }), { code });
    }
    assert.throws(
      () => createTraeParser({ productVersion: "3.3.105", profileId: "trae-cn-runtime-v2", profileVersion: 1 }),
      { code: "T2O_TRAE_PROFILE_VERSION_UNSUPPORTED" },
    );
  });
});
