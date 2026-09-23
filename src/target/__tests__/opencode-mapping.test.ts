import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { canonicalizeJson, hashCanonicalJson } from "../../ir/canonical.js";
import type { AssistantEventIR, JsonObject, MigrationBundle, ToolContentIR } from "../../ir/types.js";
import { assertOpenCodeTransfer } from "../opencode/contract.js";
import { mapOpenCodeSession } from "../opencode/mapping.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../../../fixtures/ir/v1/valid-trae-assembled.json", import.meta.url,
), "utf8")) as MigrationBundle;
const options = {
  sessionId: "ses_mapping",
  messageIds: new Map([["user-synthetic", "msg_user"], ["assistant-synthetic", "msg_assistant"]]),
  directory: "/synthetic/target",
};
const map = (bundle = structuredClone(fixture), overrides = {}) =>
  mapOpenCodeSession(bundle, "session-synthetic", { ...options, ...overrides });
const assistant = (bundle: MigrationBundle) => bundle.sessions[0].events[1] as AssistantEventIR;
const tool = (bundle: MigrationBundle) => assistant(bundle).content[3] as ToolContentIR;
const expectedRejection = { code: "T2O_OPENCODE_MAPPING_REJECTED" };

describe("OpenCode IR mapping", () => {
  it("preserves text, reasoning, order, timestamps and structured tool output", () => {
    const { transfer, diagnostics } = map();
    assertOpenCodeTransfer(transfer);
    assert.equal(transfer.info.title, fixture.sessions[0].title);
    assert.deepEqual(transfer.messages.map((message) => message.id), ["msg_user", "msg_assistant"]);
    assert.equal(transfer.messages[0].text, "Read this file. 中文\n");
    const content = transfer.messages[1].content as JsonObject[];
    assert.deepEqual(content.map((block) => block.type), ["reasoning", "text", "reasoning", "tool", "text"]);
    assert.deepEqual(content[0], { type: "reasoning", text: "First persisted reasoning." });
    assert.deepEqual(transfer.messages[1].time, { created: 1700000001000, completed: 1700000004000 });
    assert.deepEqual(content[3].time, { created: 1700000002000, completed: 1700000003000 });
    const state = content[3].state as JsonObject;
    assert.deepEqual(state.input, { path: "example.txt" });
    assert.deepEqual(state.content, [{ type: "text", text: canonicalizeJson({ text: "中文\n" }) }]);
    assert.deepEqual(state.metadata, { trae2opencode: {
      outputEncoding: "canonical-json", outputSha256: hashCanonicalJson({ text: "中文\n" }),
    } });
    assert.equal(diagnostics[0].code, "T2O_OPENCODE_SOURCE_FIELDS_UNKNOWN");
  });

  it("preserves source relationships and times absent from native text fields", () => {
    const bundle = structuredClone(fixture);
    assistant(bundle).content[0].completedAt = 1700000002000;
    assistant(bundle).content[1].createdAt = 1700000001001;
    const { transfer } = map(bundle);
    const meta = (transfer.messages[1].metadata as JsonObject).trae2opencode as JsonObject;
    assert.equal(meta.replyToSourceId, "user-synthetic");
    assert.equal(meta.turnSourceId, "turn-synthetic");
    assert.equal(meta.status, "completed");
    assert.deepEqual((meta.content as JsonObject[]).slice(0, 2),
      [{ completedAt: 1700000002000 }, { createdAt: 1700000001001 }]);
    assert.deepEqual(meta.unknownSourceFields, ["agent", "model"]);
    assert.deepEqual(transfer.messages[1].model, { id: "unknown", providerID: "trae-import-unknown" });
  });

  it("does not mutate source inputs or share tool input objects with callers", () => {
    const bundle = structuredClone(fixture);
    const before = structuredClone(bundle);
    const { transfer } = map(bundle);
    const state = (transfer.messages[1].content as JsonObject[])[3].state as JsonObject;
    (state.input as JsonObject).path = "changed";
    assert.deepEqual(bundle, before);
    assert.deepEqual(map().transfer, map().transfer);
  });

  it("encodes string, null, array and scalar tool outputs without semantic loss", () => {
    for (const output of ["", "中文\n", null, [1, "二"], false, 0]) {
      const bundle = structuredClone(fixture);
      tool(bundle).output = output;
      const state = (map(bundle).transfer.messages[1].content as JsonObject[])[3].state as JsonObject;
      const text = (state.content as JsonObject[])[0].text as string;
      assert.deepEqual(typeof output === "string" ? text : JSON.parse(text), output);
    }
  });

  it("retains verified running and streaming tools in a completed assistant", () => {
    for (const status of ["running", "streaming"] as const) {
      const bundle = structuredClone(fixture);
      Object.assign(tool(bundle), { status, input: status === "running" ? { q: "x" } : '{"q":' });
      delete tool(bundle).output;
      delete tool(bundle).completedAt;
      const { transfer } = map(bundle);
      assertOpenCodeTransfer(transfer);
      const state = (transfer.messages[1].content as JsonObject[])[3].state as JsonObject;
      assert.equal(state.status, status);
      assert.deepEqual(state.input, status === "running" ? { q: "x" } : '{"q":');
    }
  });

  it("rejects missing real timestamps and unfinished assistant states", () => {
    const mutations = [
      (b: MigrationBundle) => { delete b.sessions[0].createdAt; },
      (b: MigrationBundle) => { delete b.sessions[0].events[0].createdAt; },
      (b: MigrationBundle) => { delete assistant(b).completedAt; },
      (b: MigrationBundle) => { assistant(b).status = "running"; },
      (b: MigrationBundle) => { assistant(b).status = "unknown"; },
      (b: MigrationBundle) => { delete tool(b).createdAt; },
      (b: MigrationBundle) => { delete tool(b).completedAt; },
    ];
    for (const mutate of mutations) {
      const bundle = structuredClone(fixture);
      mutate(bundle);
      assert.throws(() => map(bundle), expectedRejection);
    }
  });

  it("rejects unsupported tool payloads, errors and states without dropping data", () => {
    const mutations = [
      (t: ToolContentIR) => { t.input = "not-an-object"; },
      (t: ToolContentIR) => { delete t.output; },
      (t: ToolContentIR) => { t.error = "source error"; },
      (t: ToolContentIR) => { t.status = "error"; },
      (t: ToolContentIR) => { t.status = "unknown"; },
      (t: ToolContentIR) => { t.status = "running"; },
      (t: ToolContentIR) => { t.status = "streaming"; t.input = ""; },
    ];
    for (const mutate of mutations) {
      const bundle = structuredClone(fixture);
      mutate(tool(bundle));
      assert.throws(() => map(bundle), expectedRejection);
    }
  });

  it("requires the exact verified source profile and runtime references on every block", () => {
    for (const mutate of [
      (b: MigrationBundle) => { b.source.product.version = "3.3.105"; },
      (b: MigrationBundle) => { b.source.profile.verification = "unverified"; },
      (b: MigrationBundle) => { b.sessions[0].events[0].sourceRefs[0].parserProfile.version = 2; },
      (b: MigrationBundle) => { tool(b).sourceRefs[0].locator.type = "relative-path"; },
      (b: MigrationBundle) => { tool(b).sourceRefs[0].sourceSessionId = "another-session"; },
    ]) {
      const bundle = structuredClone(fixture);
      mutate(bundle);
      assert.throws(() => map(bundle));
    }
  });

  it("blocks related errors and unverified tool error warnings but isolates other sessions", () => {
    const bundle = structuredClone(fixture);
    bundle.diagnostics = [{
      id: "issue", code: "T2O_TRAE_TOOL_ERROR_UNVERIFIED", severity: "warning",
      message: "synthetic", subject: { type: "session", sourceId: "session-synthetic" }, sourceRefs: [],
    }];
    assert.throws(() => map(bundle), expectedRejection);
    bundle.diagnostics[0].subject!.sourceId = "another-session";
    assert.doesNotThrow(() => map(bundle));
    bundle.diagnostics[0].severity = "error";
    bundle.diagnostics[0].subject = { type: "bundle" };
    assert.throws(() => map(bundle), expectedRejection);
  });

  it("rejects duplicate message ids, missing mappings and broken reply/order graphs", () => {
    assert.throws(() => map(undefined, { messageIds: new Map() }), expectedRejection);
    assert.throws(() => map(undefined, { messageIds: new Map([
      ["user-synthetic", "msg_same"], ["assistant-synthetic", "msg_same"],
    ]) }), expectedRejection);
    const bundle = structuredClone(fixture);
    assistant(bundle).replyToSourceId = "missing-user";
    assert.throws(() => map(bundle), expectedRejection);
    assistant(bundle).replyToSourceId = "user-synthetic";
    assistant(bundle).order = 1;
    assert.throws(() => map(bundle), expectedRejection);
  });

  it("does not import metadata-only or empty sessions", () => {
    const bundle = structuredClone(fixture);
    bundle.sessions[0].recovery = "metadata-only";
    assert.throws(() => map(bundle), expectedRejection);
    bundle.sessions[0].recovery = "complete";
    bundle.sessions[0].events = [];
    assert.throws(() => map(bundle), expectedRejection);
  });

  it("requires explicit parent mapping and reports deferred resources", () => {
    const bundle = structuredClone(fixture);
    bundle.sessions[0].resources.push({
      sourceId: "resource", type: "image", availability: "deferred",
      sourceRefs: structuredClone(bundle.sessions[0].sourceRefs),
    });
    assert.equal(map(bundle).diagnostics.at(-1)!.code, "T2O_OPENCODE_RESOURCES_DEFERRED");
    assert.throws(() => map(bundle, { parentId: "ses_unexpected" }), expectedRejection);
    const parent = structuredClone(bundle.sessions[0]);
    parent.sourceId = "parent";
    parent.events = [];
    bundle.sessions.push(parent);
    bundle.sessions[0].parentSourceId = "parent";
    assert.throws(() => map(bundle), expectedRejection);
    assert.equal(map(bundle, { parentId: "ses_parent" }).transfer.info.parentID, "ses_parent");
  });

  it("reports only safe fields in errors even for private source text", () => {
    const bundle = structuredClone(fixture);
    bundle.sessions[0].title = "private title";
    tool(bundle).error = "private payload";
    assert.throws(() => map(bundle), (error: unknown) => {
      assert.doesNotMatch(JSON.stringify(error), /private title|private payload/);
      return true;
    });
  });
});
