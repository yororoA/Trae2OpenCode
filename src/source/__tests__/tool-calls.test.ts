import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTraeRuntimeAssistantMessages } from "../trae/assistant-messages.js";
import { parseTraeToolCalls } from "../trae/tool-calls.js";

function observation(id: string, result: unknown, extras: Record<string, unknown> = {}, timing?: unknown) {
  return {
    type: "plan_item",
    plan_item: {
      id: `plan-${id}`,
      tool_call_info: { id, name: "Read", params: { file_path: "src/a.ts" }, result, ...extras },
      ...(timing === undefined ? {} : { timing }),
    },
  };
}
function parse(messages: unknown[]) {
  return parseTraeToolCalls({ messages }, "task", "3.3.104");
}

describe("parseTraeToolCalls", () => {
  it("preserves input/output and tool names without applying UI aliases or mutating input", () => {
    const input = { file_path: "src/a.ts", options: [null, true, 2] };
    const data = { content: "a\n🙂", exit_code: 9 };
    const raw = observation("call-a", { status: "success", data }, { params: input }, {
      generated_at_ms: 100, tool_call_started_at_ms: 110, tool_call_finished_at_ms: 120,
    });
    const before = JSON.stringify(raw);
    const report = parse([raw]);
    assert.equal(JSON.stringify(raw), before);
    assert.deepEqual(report.toolCalls[0].input, input);
    assert.deepEqual(report.toolCalls[0].output, data);
    assert.equal(report.toolCalls[0].name, "Read");
    assert.equal(report.toolCalls[0].status, "completed");
    assert.equal(report.toolCalls[0].completedAt, 120);
    assert.deepEqual(report.issues, []);
  });

  it("merges repeated observations by call id with terminal precedence in either order", () => {
    const active = observation("call-a", { status: "running" });
    const done = observation("call-a", { status: "success", data: { body: "result" } });
    for (const records of [[active, done], [done, active], [done, done]]) {
      const report = parse(records);
      assert.equal(report.toolCalls.length, 1);
      assert.equal(report.toolCalls[0].status, "completed");
      assert.deepEqual(report.toolCalls[0].output, { body: "result" });
      assert.equal(report.toolCalls[0].sources.length, 2);
      assert.equal(report.toolCalls[0].entryIndex, 0);
      assert.deepEqual(report.issues, []);
    }
  });

  it("fails closed on input, name, timing, and terminal payload conflicts", () => {
    const done = observation("call-a", { status: "success", data: "first" });
    const conflicts = [
      observation("call-a", { status: "success", data: "second" }),
      observation("call-a", { status: "failed", error_message: "failed" }),
      observation("call-a", { status: "success", data: "first" }, { name: "Write" }),
      observation("call-a", { status: "success", data: "first" }, { params: { file_path: "other" } }),
    ];
    for (const conflict of conflicts) {
      const report = parse([done, conflict, done]);
      assert.deepEqual(report.toolCalls, []);
      assert.ok(report.issues.some((issue) => issue.code === "T2O_TRAE_TOOL_CONFLICT"));
    }
    assert.deepEqual(parse([
      observation("call-a", { status: "running" }, {}, { tool_call_started_at_ms: 200 }),
      observation("call-a", { status: "success" }, {}, { tool_call_finished_at_ms: 100 }),
    ]).toolCalls, []);
  });

  it("retains failed payload offline with an explicit verification diagnostic", () => {
    const report = parse([observation("call-a", {
      status: "failed", data: { retry: false }, error_message: "private tool error /Users/private/a",
    })]);
    assert.equal(report.toolCalls[0].status, "error");
    assert.equal(report.toolCalls[0].error, "private tool error /Users/private/a");
    assert.deepEqual(report.issues.map((issue) => issue.code), ["T2O_TRAE_TOOL_ERROR_UNVERIFIED"]);
    assert.doesNotMatch(JSON.stringify(report.issues), /private tool error|\/Users\/private/);
  });

  it("does not invent output, completion time, or state from missing result and exit codes", () => {
    const report = parse([
      observation("call-a", undefined),
      observation("call-b", { status: "success" }),
      observation("call-c", { status: "canceled", data: { exit_code: 1 } }),
      observation("call-d", { status: "running" }),
    ]);
    assert.deepEqual(report.toolCalls.map((call) => call.status), ["unknown", "completed", "unknown", "running"]);
    assert.equal(report.toolCalls[1].output, undefined);
    assert.ok(report.toolCalls.every((call) => call.completedAt === undefined));
    assert.deepEqual(report.issues.map((issue) => issue.code),
      ["T2O_TRAE_TOOL_RESULT_MISSING", "T2O_TRAE_TOOL_STATUS_UNSUPPORTED"]);
  });

  it("rejects orphan results, invalid JSON inputs, and invalid result payloads without exposing them", () => {
    const report = parse([
      observation("", { status: "success", data: "orphan output" }),
      observation("call-b", { status: "success" }, { params: undefined }),
      observation("call-c", { status: "success", data: Number.NaN }),
      observation("call-d", "not an envelope"),
      observation("call-e", { status: "success" }, { params: { x: new Date(0) } }),
    ]);
    assert.deepEqual(report.toolCalls, []);
    assert.equal(report.issues.length, 5);
    assert.doesNotMatch(JSON.stringify(report.issues), /orphan output|not an envelope/);
  });

  it("does not use invalid tool timing and refuses unverified versions", () => {
    const report = parse([observation("call-a", { status: "success" }, {}, {
      generated_at_ms: "private invalid time", tool_call_started_at_ms: 200, tool_call_finished_at_ms: 100,
    })]);
    assert.equal(report.toolCalls[0].generatedAt, undefined);
    assert.equal(report.toolCalls[0].completedAt, undefined);
    assert.equal(report.issues.length, 2);
    assert.doesNotMatch(JSON.stringify(report.issues), /private invalid time/);
    assert.throws(() => parseTraeToolCalls({}, "task", "unverified"),
      { code: "T2O_TRAE_ASSISTANT_MESSAGE_VERSION_UNSUPPORTED" });
  });

  it("keeps tool identity scoped to its containing assistant message", () => {
    const report = parseTraeRuntimeAssistantMessages([{
      role: "assistant", message_type: "task", agent_type: "agent",
      message_id: "message-a", chat_session_id: "session-a", turn_id: "turn-a",
      reply_to_message_id: "user-a", message_index: 2, created_at: 1700000000,
      status: "completed", chat_end_time: 1700000001000,
      content: { messages: [observation("call-a", { status: "success", data: "result" })] },
    }], "3.3.104");
    assert.equal(report.messages[0].toolCalls[0].callId, "call-a");
    assert.equal(report.messages[0].sourceMessageId, "message-a");
    assert.equal(report.messages[0].planItems.length, 1);
  });
});
