import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { canonicalizeJson, hashCanonicalJson } from "../../ir/canonical.js";
import type { AssistantEventIR, JsonObject, MigrationBundle, ToolContentIR } from "../../ir/types.js";
import { assertOpenCodeTransfer } from "../opencode/contract.js";
import {
  mapOpenCodeSession,
  MISSING_ASSISTANT_TEXT,
  MISSING_TOOL_ERROR_TEXT,
  MISSING_TOOL_OUTPUT_TEXT,
} from "../opencode/mapping.js";

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

  it("folds task progress as reasoning and keeps the final response as text", () => {
    const bundle = structuredClone(fixture);
    const event = assistant(bundle);
    const progressText = event.content[1];
    assert.equal(progressText?.type, "text");
    progressText!.sourceRefs[0].locator = {
      type: "runtime-field",
      value: 'runtime:getMessages#message["assistant-synthetic"].content.messages[0].plan_item.thought',
    };
    const finalText = event.content.at(-1);
    assert.equal(finalText?.type, "text");
    finalText!.sourceRefs[0].locator = {
      type: "runtime-field",
      value: 'runtime:getMessages#message["assistant-synthetic"].content.messages[2].plan_item.tool_call_info.params.summary',
    };

    const content = map(bundle).transfer.messages[1].content as JsonObject[];
    assert.deepEqual(content.map((block) => block.type),
      ["reasoning", "reasoning", "reasoning", "tool", "text"]);
    assert.equal(content[1].text, "Opening text.\n");
    assert.equal(content.at(-1)?.text, "Final response.\n");
    assert.equal(content.some((block) => block.type === "text" && block.text === "---"), false);

    event.content = [finalText!];
    const summaryOnly = map(bundle).transfer.messages[1].content as JsonObject[];
    assert.deepEqual(summaryOnly, [{ type: "text", text: "Final response.\n" }]);
  });

  it("projects TRAE exec commands to expandable native shell tools without losing source fields", () => {
    const bundle = structuredClone(fixture);
    Object.assign(tool(bundle), {
      name: "exec_command",
      input: {
        cmd: "git status --short",
        workdir: "/synthetic/project",
        yield_time_ms: 10_000,
      },
      output: {
        stdout: "clean\n",
        output: "clean\n",
        exit_code: 0,
        status: "Exited",
      },
    });

    const { transfer } = map(bundle);
    const part = (transfer.messages[1].content as JsonObject[])[3];
    const state = part.state as JsonObject;
    const metadata = (state.metadata as JsonObject).trae2opencode as JsonObject;

    assert.equal(part.name, "shell");
    assert.deepEqual(state.input, {
      command: "git status --short",
      workdir: "/synthetic/project",
      yield_time_ms: 10_000,
    });
    assert.deepEqual(state.content, [{ type: "text", text: "clean\n" }]);
    assert.equal(metadata.sourceToolName, "exec_command");
    assert.equal(metadata.sourceCommandField, "cmd");
    assert.equal(metadata.visibleOutputField, "stdout");
    assert.deepEqual(metadata.mirroredOutputFields, ["stdout", "output"]);
    assert.deepEqual(metadata.sourceOutputRemainder, { exit_code: 0, status: "Exited" });
    assert.equal(metadata.sourceOutputSha256, hashCanonicalJson(tool(bundle).output!));
    assert.equal(metadata.outputEncoding, "text");
    assert.equal(metadata.outputSha256, hashCanonicalJson("clean\n"));
  });

  it("keeps running TRAE exec command output expandable through shell metadata", () => {
    const bundle = structuredClone(fixture);
    Object.assign(tool(bundle), {
      name: "exec_command",
      status: "running",
      input: { cmd: "npm test", workdir: "/synthetic/project" },
      output: { stdout: "still running\n", output: "still running\n", status: "Running" },
    });
    bundle.sessions[0].recovery = "partial";

    const { transfer } = map(bundle);
    const part = (transfer.messages[1].content as JsonObject[])[3];
    const state = part.state as JsonObject;
    const metadata = state.metadata as JsonObject;
    const source = metadata.trae2opencode as JsonObject;

    assert.equal(part.name, "shell");
    assert.equal(state.status, "running");
    assert.deepEqual(state.input, { command: "npm test", workdir: "/synthetic/project" });
    assert.equal(metadata.output, "still running\n");
    assert.equal(source.sourceOutput, undefined);
    assert.deepEqual(source.sourceOutputRemainder, { status: "Running" });
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

  it("marks a completed tool whose source output was not persisted", () => {
    const bundle = structuredClone(fixture);
    delete tool(bundle).output;
    delete tool(bundle).completedAt;
    bundle.sessions[0].recovery = "partial";

    const { transfer, diagnostics } = map(bundle);
    const state = (transfer.messages[1].content as JsonObject[])[3].state as JsonObject;

    assert.deepEqual(state.content, [{ type: "text", text: MISSING_TOOL_OUTPUT_TEXT }]);
    assert.equal((state.metadata as JsonObject).trae2opencode !== undefined, true);
    assert.equal(
      ((state.metadata as JsonObject).trae2opencode as JsonObject).sourceOutputMissing,
      true,
    );
    assert.ok(diagnostics.some((item) => item.code === "T2O_OPENCODE_TOOL_OUTPUT_MISSING"));
    assert.ok(diagnostics.some((item) => item.code === "T2O_OPENCODE_TOOL_COMPLETION_TIME_MISSING"));
  });

  it("retains an untimed partial tool in metadata without rendering JSON as chat text", () => {
    const complete = structuredClone(fixture);
    delete tool(complete).createdAt;
    assert.throws(() => map(complete), expectedRejection);

    complete.sessions[0].recovery = "partial";
    const { transfer, diagnostics } = map(complete);
    const content = transfer.messages[1].content as JsonObject[];
    const metadata = (transfer.messages[1].metadata as JsonObject).trae2opencode as JsonObject;
    const deferred = metadata.deferredContent as JsonObject[];
    const deferredBlock = deferred[0].block as JsonObject;

    assert.deepEqual(content.map((block) => block.type), ["reasoning", "text", "reasoning", "text"]);
    assert.equal(deferred[0].sourceIndex, 3);
    assert.equal(deferredBlock.callId, tool(complete).callId);
    assert.deepEqual(deferredBlock.output, tool(complete).output);
    assert.ok(diagnostics.some((item) => item.code === "T2O_OPENCODE_TOOL_TIMING_MISSING"));
  });

  it("uses the native unknown finish reason only for partial assistant messages", () => {
    const bundle = structuredClone(fixture);
    assistant(bundle).status = "unknown";
    assert.throws(() => map(bundle), expectedRejection);

    bundle.sessions[0].recovery = "partial";
    const { transfer, diagnostics } = map(bundle);
    assert.equal(transfer.messages[1].finish, "unknown");
    assert.ok(diagnostics.some((item) => item.code === "T2O_OPENCODE_ASSISTANT_STATUS_PROJECTED"));
  });

  it("marks a partial assistant whose final text was not persisted", () => {
    const bundle = structuredClone(fixture);
    assistant(bundle).content = assistant(bundle).content.filter((block) => block.type !== "text");
    bundle.sessions[0].recovery = "partial";
    bundle.diagnostics.push({
      id: "missing-text", code: "T2O_TRAE_ASSISTANT_MESSAGE_TEXT_MISSING",
      message: "synthetic", severity: "warning",
      subject: { type: "session", sourceId: "session-synthetic" },
      sourceRefs: [], context: { sourceMessageId: "assistant-synthetic" },
    });

    const { transfer, diagnostics } = map(bundle);
    const content = transfer.messages[1].content as JsonObject[];

    assert.deepEqual(content.at(-1), { type: "text", text: MISSING_ASSISTANT_TEXT });
    assert.ok(diagnostics.some((item) => item.code === "T2O_OPENCODE_ASSISTANT_TEXT_MISSING"));
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

  it("preserves running payloads and projects unknown tool states without claiming completion", () => {
    for (const status of ["running", "unknown"] as const) {
      const bundle = structuredClone(fixture);
      Object.assign(tool(bundle), {
        status,
        output: { retained: true },
        error: status === "unknown" ? "source error" : undefined,
      });
      bundle.sessions[0].recovery = "partial";
      const { transfer, diagnostics } = map(bundle);
      const state = (transfer.messages[1].content as JsonObject[])[3].state as JsonObject;
      const metadata = (state.metadata as JsonObject).trae2opencode as JsonObject;

      assert.equal(state.status, "running");
      assert.equal(metadata.sourceStatus, status);
      assert.deepEqual(metadata.sourceOutput, { retained: true });
      assert.equal(metadata.sourceError, status === "unknown" ? "source error" : undefined);
      assert.ok(diagnostics.some((item) => item.code === (
        status === "unknown"
          ? "T2O_OPENCODE_TOOL_STATUS_PROJECTED"
          : "T2O_OPENCODE_RUNNING_TOOL_PAYLOAD_PRESERVED"
      )));
    }
  });

  it("maps failed tools to the native error state while preserving output", () => {
    for (const sourceError of ["source error", { code: 7 }, undefined]) {
      const bundle = structuredClone(fixture);
      Object.assign(tool(bundle), { status: "error", error: sourceError, output: { retained: true } });
      if (sourceError === undefined) delete tool(bundle).error;
      bundle.sessions[0].recovery = "partial";
      const { transfer, diagnostics } = map(bundle);
      const state = (transfer.messages[1].content as JsonObject[])[3].state as JsonObject;
      const error = state.error as JsonObject;
      const metadata = (state.metadata as JsonObject).trae2opencode as JsonObject;

      assert.equal(state.status, "error");
      assert.equal(error.type, "TRAE_TOOL_ERROR");
      assert.equal(error.message, sourceError === undefined
        ? MISSING_TOOL_ERROR_TEXT
        : typeof sourceError === "string" ? sourceError : canonicalizeJson(sourceError));
      assert.deepEqual(state.content, [{ type: "text", text: canonicalizeJson({ retained: true }) }]);
      assert.equal(metadata.sourceErrorMissing, sourceError === undefined ? true : undefined);
      assert.ok(diagnostics.some((item) => item.code === "T2O_OPENCODE_TOOL_ERROR_PRESERVED"));
    }
  });

  it("rejects missing real timestamps and unfinished assistant states", () => {
    const mutations = [
      (b: MigrationBundle) => { delete b.sessions[0].createdAt; },
      (b: MigrationBundle) => { delete b.sessions[0].events[0].createdAt; },
      (b: MigrationBundle) => { delete assistant(b).completedAt; },
      (b: MigrationBundle) => { assistant(b).status = "running"; },
      (b: MigrationBundle) => { assistant(b).status = "unknown"; },
    ];
    for (const mutate of mutations) {
      const bundle = structuredClone(fixture);
      mutate(bundle);
      assert.throws(() => map(bundle), expectedRejection);
    }
  });

  it("rejects tool payload shapes that the target cannot represent", () => {
    const mutations = [
      (t: ToolContentIR) => { t.input = "not-an-object"; },
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

  it("projects allowlisted source failures only for partial sessions", () => {
    const bundle = structuredClone(fixture);
    bundle.diagnostics = [{
      id: "issue", code: "T2O_TRAE_TOOL_ERROR_UNVERIFIED", severity: "warning",
      message: "synthetic", subject: { type: "session", sourceId: "session-synthetic" }, sourceRefs: [],
    }];
    assert.throws(() => map(bundle), expectedRejection);
    bundle.sessions[0].recovery = "partial";
    assert.doesNotThrow(() => map(bundle));
    assert.deepEqual(
      ((map(bundle).transfer.info.metadata as JsonObject).trae2opencode as JsonObject).projectedSourceCodes,
      ["T2O_TRAE_TOOL_ERROR_UNVERIFIED"],
    );
    bundle.diagnostics[0].subject!.sourceId = "another-session";
    assert.doesNotThrow(() => map(bundle));
    bundle.diagnostics[0].severity = "error";
    bundle.diagnostics[0].subject = { type: "bundle" };
    assert.throws(() => map(bundle), expectedRejection);
  });

  it("rejects duplicate message ids and projects broken replies only for partial sessions", () => {
    assert.throws(() => map(undefined, { messageIds: new Map() }), expectedRejection);
    assert.throws(() => map(undefined, { messageIds: new Map([
      ["user-synthetic", "msg_same"], ["assistant-synthetic", "msg_same"],
    ]) }), expectedRejection);
    const bundle = structuredClone(fixture);
    assistant(bundle).replyToSourceId = "missing-user";
    assert.throws(() => map(bundle), expectedRejection);
    bundle.sessions[0].recovery = "partial";
    const projected = map(bundle);
    const metadata =
      (projected.transfer.messages[1].metadata as JsonObject).trae2opencode as JsonObject;
    assert.equal(metadata.replyToSourceId, undefined);
    assert.equal(metadata.unresolvedReplyToSourceId, "missing-user");
    assert.equal(metadata.replyReferenceStatus, "unresolved");
    assert.ok(projected.diagnostics.some(
      (item) => item.code === "T2O_OPENCODE_REPLY_REFERENCE_UNRESOLVED",
    ));
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
