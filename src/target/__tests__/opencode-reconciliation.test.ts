import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { JsonObject, MigrationBundle } from "../../ir/types.js";
import { mapOpenCodeSession, type OpenCodeTransfer } from "../opencode/mapping.js";
import { reconcileOpenCodeTransfer, requireOpenCodeReconciliation } from "../opencode/reconciliation.js";

const bundle = JSON.parse(readFileSync(new URL(
  "../../../fixtures/ir/v1/valid-trae-assembled.json", import.meta.url,
), "utf8")) as MigrationBundle;
const expected = mapOpenCodeSession(bundle, "session-synthetic", {
  sessionId: "ses_verify", directory: "/synthetic/target",
  messageIds: new Map([["user-synthetic", "msg_u"], ["assistant-synthetic", "msg_a"]]),
}).transfer;

describe("OpenCode readback reconciliation", () => {
  it("verifies every message and metadata while reporting observed target projections", () => {
    const actual = structuredClone(expected);
    actual.info.projectID = "target-project";
    actual.info.subpath = ".";
    actual.info.time.updated++;
    const result = requireOpenCodeReconciliation(expected, actual);
    assert.equal(result.status, "verified");
    assert.deepEqual(result.expected.counts,
      { messages: 2, users: 1, assistants: 1, text: 2, reasoning: 2, tools: 1 });
    assert.deepEqual(result.actual, result.expected);
    assert.deepEqual(result.allowedProjections, ["info.projectID", "info.subpath", "info.time.updated"]);
    assert.deepEqual(result.differences, []);
  });

  it("detects a dropped assistant even when the remaining transfer is schema-valid", () => {
    const actual = structuredClone(expected);
    actual.messages.pop();
    const result = reconcileOpenCodeTransfer(expected, actual);
    assert.equal(result.status, "mismatch");
    assert.equal(result.actual.counts.assistants, 0);
    assert.deepEqual(result.differences, ["messages.length", "messages[1]"]);
    assert.throws(() => requireOpenCodeReconciliation(expected, actual),
      { code: "T2O_OPENCODE_RECONCILIATION_FAILED" });
  });

  it("detects message order, block order, text, timestamp, relation and tool changes", () => {
    const mutations: Array<(value: OpenCodeTransfer) => void> = [
      (value) => { value.messages.reverse(); },
      (value) => { (value.messages[1].content as JsonObject[]).reverse(); },
      (value) => { value.messages[0].text = "changed"; },
      (value) => { (value.messages[1].time as JsonObject).completed = 1700000004001; },
      (value) => { ((value.messages[1].metadata as JsonObject).trae2opencode as JsonObject).replyToSourceId = "wrong"; },
      (value) => { ((value.messages[1].content as JsonObject[])[3].state as JsonObject).input = { path: "other" }; },
      (value) => { ((value.messages[1].content as JsonObject[])[3].state as JsonObject).content = [{ type: "text", text: "wrong" }]; },
      (value) => { (value.messages[1].content as JsonObject[])[3].state = { status: "running", input: {}, metadata: {} }; },
      (value) => { (value.info.metadata as JsonObject).trae2opencode = {}; },
      (value) => { value.info.time.created++; },
      (value) => { value.info.location.directory = "/other"; },
      (value) => { value.info.parentID = "ses_other"; },
    ];
    for (const mutate of mutations) {
      const actual = structuredClone(expected);
      mutate(actual);
      assert.equal(reconcileOpenCodeTransfer(expected, actual).status, "mismatch");
    }
  });

  it("accepts only the model variant projection, not a changed model identity", () => {
    const source = structuredClone(expected);
    source.info.model = { id: "source-model", providerID: "provider", variant: "source" };
    const actual = structuredClone(source);
    (actual.info.model as JsonObject).variant = "default";
    assert.equal(requireOpenCodeReconciliation(source, actual).status, "verified");
    (actual.info.model as JsonObject).id = "different";
    assert.equal(reconcileOpenCodeTransfer(source, actual).status, "mismatch");
  });

  it("treats object key order as equal without modifying either input", () => {
    const actual = structuredClone(expected);
    actual.messages = actual.messages.map((message) => Object.fromEntries(Object.entries(message).reverse()));
    const before = structuredClone(actual);
    assert.equal(requireOpenCodeReconciliation(expected, actual).status, "verified");
    assert.deepEqual(actual, before);
  });

  it("never prints private content, paths or dynamic metadata keys in discrepancy reports", () => {
    const actual = structuredClone(expected);
    actual.messages[0].text = "PRIVATE_TEXT";
    actual.messages[1].metadata = { PRIVATE_KEY: "/Users/private/path" };
    actual.info.title = "PRIVATE_TITLE";
    const result = reconcileOpenCodeTransfer(expected, actual);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|\/Users\/private|synthetic/);
    assert.throws(() => requireOpenCodeReconciliation(expected, actual), (error: unknown) => {
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|\/Users\/private|synthetic/);
      return true;
    });
  });

  it("bounds difference locations while retaining the exact discrepancy count", () => {
    const source = structuredClone(expected);
    source.messages = Array.from({ length: 1200 }, (_, index) => ({
      id: `msg_${index}`, type: "user", text: "source", time: { created: index },
    }));
    const actual = structuredClone(source);
    for (const message of actual.messages) message.text = "different";
    const result = reconcileOpenCodeTransfer(source, actual);
    assert.equal(result.differenceCount, 1200);
    assert.equal(result.differences.length, 1000);
    assert.equal(result.status, "mismatch");
  });

  it("rejects invalid readback unions before reporting verification", () => {
    const actual = structuredClone(expected);
    actual.messages[1].type = "unknown";
    assert.throws(() => reconcileOpenCodeTransfer(expected, actual), { code: "T2O_OPENCODE_TRANSFER_INVALID" });
  });
});
