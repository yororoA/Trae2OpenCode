import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { canonicalizeJson, hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonObject, MigrationBundle } from "../../ir/types.js";
import { isRecord } from "../opencode/contract.js";
import { V1_MAPPING_VERSION, mapOpenCodeV1Session } from "../opencode/v1/mapping.js";
import { assertOpenCodeV1Session } from "../opencode/v1/contract.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../../../fixtures/ir/v1/valid-trae-assembled.json", import.meta.url,
), "utf8")) as MigrationBundle;
const options = {
  sessionId: "ses_v1_mapping",
  messageIds: new Map([["user-synthetic", "msg_0001_user"], ["assistant-synthetic", "msg_0002_assistant"]]),
  directory: "/synthetic/target",
  targetVersion: "1.18.32",
};
const map = (bundle = structuredClone(fixture), overrides = {}) =>
  mapOpenCodeV1Session(bundle, "session-synthetic", { ...options, ...overrides });
const markerOf = (message: JsonObject) => {
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  return isRecord(metadata.trae2opencode) ? metadata.trae2opencode : {};
};
const infoOf = (message: JsonObject): JsonObject => message.info as JsonObject;
const roleOf = (message: JsonObject): unknown => infoOf(message).role;

describe("OpenCode v1 IR mapping", () => {
  it("produces a schema-valid v1 session with order-preserving part ids", () => {
    const { transfer, diagnostics } = map();
    assertOpenCodeV1Session(transfer);
    assert.equal(transfer.info.version, "1.18.32");
    assert.equal(transfer.info.directory, "/synthetic/target");
    assert.equal(transfer.info.slug, "trae-import-v1_mappi");
    assert.deepEqual(transfer.messages.map(roleOf), ["user", "assistant"]);
    const parts = transfer.messages[1].parts as JsonObject[];
    assert.deepEqual(parts.map((part) => part.type), ["reasoning", "text", "reasoning", "tool", "text"]);
    // v1 reads parts back ordered by id, so the ids must already be in transcript order.
    const ids = parts.map((part) => String(part.id));
    assert.deepEqual(ids, [...ids].sort());
    for (const part of parts) assert.match(String(part.id), /^prt_/);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      diagnostics.filter((issue) => issue.code.startsWith("T2O_OPENCODE_V1_")).map((issue) => issue.code).sort(),
      [
        "T2O_OPENCODE_V1_PART_END_PROJECTED",
        "T2O_OPENCODE_V1_PART_START_PROJECTED",
        "T2O_OPENCODE_V1_PROVENANCE_AT_SESSION",
      ],
    );
  });

  it("keeps the assistant reply relation and the tool payload in native v1 fields", () => {
    const { transfer } = map();
    const assistant = infoOf(transfer.messages[1]);
    assert.equal(assistant.parentID, "msg_0001_user");
    assert.equal(assistant.modelID, "unknown");
    assert.deepEqual(assistant.path, { cwd: "/synthetic/target", root: "/synthetic/target" });
    const tool = (transfer.messages[1].parts as JsonObject[])[3];
    assert.equal(tool.callID, "call-synthetic");
    assert.equal(tool.tool, "read_file");
    const state = tool.state as JsonObject;
    assert.equal(state.status, "completed");
    assert.equal(state.title, "read_file");
    assert.deepEqual(state.input, { path: "example.txt" });
    assert.equal(state.output, canonicalizeJson({ text: "中文\n" }));
    assert.deepEqual(state.metadata, { trae2opencode: {
      outputEncoding: "canonical-json", outputSha256: hashCanonicalJson({ text: "中文\n" }),
    } });
  });

  it("projects part start and end times from the containing turn instead of blocking", () => {
    const { transfer } = map();
    const parts = transfer.messages[1].parts as JsonObject[];
    assert.deepEqual(parts[0].time, { start: 1700000001000, end: 1700000004000 });
    assert.equal(parts[1].time, undefined);
    // A v1 tool keeps its own persisted run window inside the tool state.
    assert.deepEqual((parts[3].state as JsonObject).time, { start: 1700000002000, end: 1700000003000 });
  });

  it("carries per-event provenance on the session because v1 messages have no metadata", () => {
    const { transfer } = map();
    const marker = markerOf(transfer.info);
    assert.equal(marker.mappingVersion, V1_MAPPING_VERSION);
    assert.equal(marker.dialect, "v1");
    assert.equal(marker.sourceSessionId, "session-synthetic");
    assert.equal(marker.eventCount, 2);
    const events = marker.events as JsonObject[];
    assert.deepEqual(events.map((event) => event.sourceId), ["user-synthetic", "assistant-synthetic"]);
    assert.equal(events[1].replyToSourceId, "user-synthetic");
    assert.equal(events[0].status, null);
    assert.equal(Object.hasOwn(transfer.messages[0], "metadata"), false);
  });

  it("omits v2-only compaction checkpoints and reports the omission", () => {
    const bundle = structuredClone(fixture);
    const user = bundle.sessions[0].events[0];
    if (user?.type !== "user") throw new Error("fixture shape changed");
    user.text = "x".repeat(200_000);
    const mapped = map(bundle);
    assert.equal(mapped.transfer.messages.length, 2);
    assert.ok(!mapped.transfer.messages.some((message) => roleOf(message) === "compaction"));
    assert.ok(!mapped.diagnostics.some((issue) => issue.code === "T2O_OPENCODE_CONTINUATION_BOUNDARY"));
    assert.ok(mapped.diagnostics.some((issue) =>
      issue.code === "T2O_OPENCODE_V1_CONTINUATION_BOUNDARY_OMITTED"));
    assert.equal(markerOf(mapped.transfer.info).continuationBoundariesOmitted, 1);
  });

  it("rejects a state v1 cannot persist without inventing data", () => {
    const bundle = structuredClone(fixture);
    // A partial source may project an unresolved reply, but v1 requires a real parent id.
    bundle.sessions[0].recovery = "partial";
    const event = bundle.sessions[0].events[1];
    if (event?.type !== "assistant") throw new Error("fixture shape changed");
    delete event.replyToSourceId;
    const error = (() => {
      try {
        map(bundle);
      } catch (thrown) {
        return thrown as { code?: string; diagnostics?: Array<{ context?: unknown }> };
      }
      throw new Error("mapping should have been rejected");
    })();
    assert.equal(error.code, "T2O_OPENCODE_V1_UNSUPPORTED_STATE");
    assert.deepEqual(error.diagnostics?.map((issue) => issue.context), [{ field: "assistant.reply" }]);
  });

  it("projects an interrupted tool to pending raw input and says so", () => {
    const bundle = structuredClone(fixture);
    const event = bundle.sessions[0].events[1];
    if (event?.type !== "assistant") throw new Error("fixture shape changed");
    const block = event.content[3];
    if (block?.type !== "tool") throw new Error("fixture shape changed");
    block.status = "streaming";
    block.input = "{\"path\":";
    block.output = undefined;
    block.completedAt = undefined;
    const { transfer, diagnostics } = map(bundle);
    const parts = transfer.messages[1].parts as JsonObject[];
    assert.deepEqual(parts[3].state, { status: "pending", input: {}, raw: "{\"path\":" });
    assert.ok(diagnostics.some((issue) => issue.code === "T2O_OPENCODE_V1_TOOL_STATUS_PROJECTED"));
  });
});