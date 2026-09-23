import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTraeReasoningPlan, runtimeHash } from "../trae/reasoning-plan.js";

function plan(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "plan_item",
    plan_item: { id, thought: "", reasoning_content: "", ...overrides },
  };
}

describe("parseTraeReasoningPlan", () => {
  it("preserves general reasoning verbatim with an auditable source", () => {
    const text = "  已持久化 reasoning\n🙂\n";
    const report = parseTraeReasoningPlan(JSON.stringify({
      content: "visible text",
      reasoning_content: text,
    }), "general", "3.3.104");
    assert.deepEqual(report.reasoningBlocks, [{
      text,
      entryIndex: -1,
      source: { locator: "content.reasoning_content", sha256: runtimeHash(text) },
    }]);
    assert.deepEqual(report.issues, []);
  });

  it("retains proposal and plan reasoning once in persisted order", () => {
    const report = parseTraeReasoningPlan({ messages: [
      { type: "proposal", proposal: { content: { reasoning_content: "proposal" } } },
      plan("plan-a", { reasoning_content: "same" }),
      plan("plan-b", { reasoning_content: "same" }),
    ] }, "task", "3.3.104");
    assert.deepEqual(report.reasoningBlocks.map((block) => [block.entryIndex, block.text]),
      [[0, "proposal"], [1, "same"], [2, "same"]]);
    assert.equal(report.planItems.length, 2);
    assert.deepEqual(report.issues, []);
  });

  it("keeps hashes for unmapped plan thoughts without exposing them in diagnostics", () => {
    const thought = "private plan thought /Users/private/file";
    const report = parseTraeReasoningPlan({ messages: [
      plan("plan-a", { thought }),
      plan("plan-b", { thought: "already visible" }),
    ] }, "task", "3.3.104", ["content.messages[1].plan_item.thought"]);
    assert.equal(report.planItems[0].thought?.chars, thought.length);
    assert.equal(report.planItems[0].thought?.source.sha256, runtimeHash(thought));
    assert.deepEqual(report.issues.map((issue) => issue.code), ["T2O_TRAE_PLAN_THOUGHT_UNMAPPED"]);
    assert.doesNotMatch(JSON.stringify(report), /private plan thought|\/Users\/private/);
    assert.deepEqual(report.reasoningBlocks, []);
  });

  it("deduplicates identical plan items and rejects every conflicting identity", () => {
    const a = plan("plan-a", { reasoning_content: "accepted" });
    const b = plan("plan-b", { reasoning_content: "private conflicting text" });
    const report = parseTraeReasoningPlan({ messages: [
      a, { ...a }, b,
      plan("plan-b", { reasoning_content: "different" }),
      b,
    ] }, "task", "3.3.104");
    assert.deepEqual(report.planItems.map((item) => item.sourcePlanItemId), ["plan-a"]);
    assert.deepEqual(report.reasoningBlocks.map((item) => item.text), ["accepted"]);
    assert.deepEqual(report.issues.map((issue) => issue.code), ["T2O_TRAE_PLAN_ITEM_CONFLICT"]);
    assert.doesNotMatch(JSON.stringify(report.issues), /private conflicting text/);
  });

  it("isolates malformed fields and unsupported blocks without guessing reasoning", () => {
    const report = parseTraeReasoningPlan({ messages: [
      plan("plan-a", { reasoning_content: { secret: "private" } }),
      plan("plan-b", { thought: "plain plan", reasoning_content: "" }),
      plan("/Users/private/unsafe", { reasoning_content: "not safe" }),
      { type: "agent_call", agent_call: { description: "not reasoning" } },
      plan("plan-c", { reasoning_content: "valid" }),
    ] }, "task", "3.3.104");
    assert.deepEqual(report.reasoningBlocks.map((block) => block.text), ["valid"]);
    assert.deepEqual(report.issues.map((issue) => issue.code), [
      "T2O_TRAE_REASONING_INVALID", "T2O_TRAE_PLAN_THOUGHT_UNMAPPED",
      "T2O_TRAE_PLAN_ITEM_INVALID", "T2O_TRAE_CONTENT_TYPE_UNSUPPORTED",
    ]);
    assert.doesNotMatch(JSON.stringify(report.issues), /secret|private|plain plan|not reasoning/);
  });

  it("does not invent absent reasoning and fails closed for malformed containers and versions", () => {
    for (const reasoning_content of [undefined, null, "", " \n"]) {
      assert.deepEqual(parseTraeReasoningPlan({ reasoning_content }, "general", "3.3.104").reasoningBlocks, []);
    }
    assert.equal(parseTraeReasoningPlan("bad JSON", "task", "3.3.104").issues.length, 1);
    assert.equal(parseTraeReasoningPlan({}, "task", "3.3.104").issues.length, 1);
    assert.throws(() => parseTraeReasoningPlan({}, "general", "unknown"),
      { code: "T2O_TRAE_ASSISTANT_MESSAGE_VERSION_UNSUPPORTED" });
  });
});
