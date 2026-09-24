import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { canonicalizeMigrationBundle } from "../../ir/canonical.js";
import { validateMigrationBundleIntegrity } from "../../ir/integrity.js";
import type { JsonObject } from "../../ir/types.js";
import { assembleTraeMigrationBundle, type AssembleTraeBundleOptions } from "../trae/assemble-bundle.js";
import { selectBundle } from "../trae/collect.js";
import { runtimeHash } from "../trae/reasoning-plan.js";

const fixturePath = "fixtures/source/trae-cn-3.3.104/assembly.json";
function input(): AssembleTraeBundleOptions {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}
function messages(options: AssembleTraeBundleOptions): JsonObject[] {
  const read = options.messageReads[0];
  assert.equal(read.status, "available");
  return read.value as JsonObject[];
}
function toolResult(options: AssembleTraeBundleOptions): JsonObject {
  const content = messages(options)[0].content as JsonObject;
  const entries = content.messages as JsonObject[];
  const plan = entries[1].plan_item as JsonObject;
  return (plan.tool_call_info as JsonObject).result as JsonObject;
}
function codes(options: AssembleTraeBundleOptions) {
  return assembleTraeMigrationBundle(options).diagnostics.map((diagnostic) => diagnostic.code);
}

describe("assembleTraeMigrationBundle", () => {
  it("keeps message and interleaved content order, Unicode, payloads, times and exact sources", () => {
    const bundle = assembleTraeMigrationBundle(input());
    const session = bundle.sessions[0];
    assert.equal(session.recovery, "complete");
    assert.deepEqual(bundle.diagnostics, []);
    assert.deepEqual(session.events.map((event) => event.sourceId), ["user-synthetic", "assistant-synthetic"]);
    const assistant = session.events[1];
    assert.equal(assistant.type, "assistant");
    assert.deepEqual(assistant.content.map((block) => block.type), ["reasoning", "text", "reasoning", "tool", "text"]);
    const tool = assistant.content[3];
    assert.equal(tool.type, "tool");
    assert.deepEqual(tool.input, { path: "example.txt" });
    assert.deepEqual(tool.output, { text: "中文\n" });
    assert.equal(tool.createdAt, 1700000002000);
    assert.equal(tool.completedAt, 1700000003000);
    assert.match(tool.sourceRefs[0].locator.value, /message\["assistant-synthetic"\]\.content\.messages\[1\]/);
    assert.equal(tool.sourceRefs[0].parserProfile.id, "trae-cn-runtime-v2");
    assert.equal(assistant.completedAt, 1700000004000);
    assert.deepEqual(validateMigrationBundleIntegrity(bundle), []);
  });

  it("deduplicates identical runtime observations without changing the IR", () => {
    const options = input();
    const expected = assembleTraeMigrationBundle(options);
    messages(options).push(structuredClone(messages(options)[0]));
    messages(options).reverse();
    assert.deepEqual(assembleTraeMigrationBundle(options), expected);
  });

  it("rejects cross-role IDs and preserves a diagnostic for each conflicted source", () => {
    const options = input();
    messages(options)[0].message_id = "user-synthetic";
    const bundle = assembleTraeMigrationBundle(options);
    assert.equal(bundle.sessions[0].events.length, 0);
    assert.notEqual(bundle.sessions[0].recovery, "complete");
    assert.ok(bundle.diagnostics.some((diagnostic) => diagnostic.code === "T2O_IR_EVENT_ID_CONFLICT"));
  });

  it("keeps conflicting order and invalid reply visible and prevents complete recovery", () => {
    const options = input();
    messages(options)[0].message_index = 1;
    messages(options)[0].reply_to_message_id = "absent-user";
    const bundle = assembleTraeMigrationBundle(options);
    assert.equal(bundle.sessions[0].recovery, "partial");
    assert.ok(bundle.diagnostics.some((diagnostic) => diagnostic.code === "T2O_IR_EVENT_ORDER_CONFLICT"));
    assert.ok(bundle.diagnostics.some((diagnostic) => diagnostic.code === "T2O_IR_REPLY_REFERENCE_INVALID"));
  });

  it("excludes foreign-session messages without leaking their body into diagnostics", () => {
    const options = input();
    messages(options)[0].chat_session_id = "session-foreign";
    const bundle = assembleTraeMigrationBundle(options);
    assert.equal(bundle.sessions[0].events.length, 1);
    assert.ok(bundle.diagnostics.some((diagnostic) => diagnostic.code === "T2O_IR_MESSAGE_SESSION_MISMATCH"));
    assert.doesNotMatch(JSON.stringify(bundle.diagnostics), /First persisted|Read this file|Tool reasoning/);
  });

  it("does not manufacture completion time or trust an unknown total", () => {
    const options = input();
    delete messages(options)[0].chat_end_time;
    const read = options.messageReads[0];
    assert.equal(read.status, "available");
    delete read.expectedMessageCount;
    const bundle = assembleTraeMigrationBundle(options);
    assert.equal(bundle.sessions[0].recovery, "partial");
    const assistant = bundle.sessions[0].events[1];
    assert.equal(assistant.type, "assistant");
    assert.equal(assistant.completedAt, undefined);
    assert.ok(bundle.diagnostics.some((diagnostic) => diagnostic.code === "T2O_RECOVERY_MESSAGE_COUNT_UNKNOWN"));
  });

  it("reports runtime unavailable, error and invalid container without synthesizing events", () => {
    for (const status of ["unavailable", "error"] as const) {
      const options = input();
      options.messageReads = [{ sourceSessionId: "session-synthetic", status }];
      const bundle = assembleTraeMigrationBundle(options);
      assert.equal(bundle.sessions[0].recovery, "metadata-only");
      assert.deepEqual(bundle.sessions[0].events, []);
    }
    const options = input();
    options.messageReads = [{ sourceSessionId: "session-synthetic", status: "available", value: {} }];
    assert.ok(codes(options).includes("T2O_TRAE_USER_MESSAGE_CONTAINER_INVALID"));
  });

  it("does not guess a project in a multi-root workspace", () => {
    const options = input();
    options.workspaces.workspaces[0].projects.push({
      path: "/synthetic/other", source: "workspace-folder-path", exists: false,
    });
    const bundle = assembleTraeMigrationBundle(options);
    assert.equal(bundle.projects.length, 2);
    assert.equal(bundle.sessions[0].projectPath, undefined);
    assert.equal(bundle.sessions[0].recovery, "partial");
    assert.ok(codes(options).includes("T2O_IR_PROJECT_UNRESOLVED"));
  });

  it("requires explicit session association for resources and preserves missing references", () => {
    const options = input();
    const source = {
      kind: "workspace-resource" as const, locator: "paste-files/example.txt",
      workspaceStorageId: "workspace-synthetic", sha256: runtimeHash("resource"),
    };
    options.resources.resources = [{
      sourceId: "resource-synthetic", workspaceStorageId: "workspace-synthetic",
      type: "file", availability: "missing", relativePath: "paste-files/example.txt",
      sources: [source], references: [],
    }];
    assert.equal(assembleTraeMigrationBundle(options).sessions[0].resources.length, 0);
    options.resources.resources[0].references.push({
      ...source, kind: "explicit-reference", locator: "explicit-reference[0]", sourceSessionId: "session-synthetic",
    });
    const bundle = assembleTraeMigrationBundle(options);
    assert.equal(bundle.sessions[0].resources.length, 1);
    assert.equal(bundle.sessions[0].resources[0].sourceRefs.length, 2);
    assert.equal(bundle.sessions[0].recovery, "partial");
  });

  it("scopes workspace resource failures to sessions in that workspace", () => {
    const options = input();
    const second = structuredClone(options.metadata.sessions[0]);
    second.sourceSessionId = "session-other";
    second.workspaceStorageIds = ["workspace-other"];
    second.sources = second.sources.map((source) => ({
      ...source, workspaceStorageId: "workspace-other",
    }));
    options.metadata.sessions.push(second);
    options.resources.issues.push({
      code: "T2O_TRAE_RESOURCE_SCAN_FAILED",
      severity: "error",
      message: "A TRAE resource directory could not be scanned.",
      workspaceStorageId: "workspace-other",
    });
    const bundle = assembleTraeMigrationBundle(options);
    const issue = bundle.diagnostics.find((diagnostic) =>
      diagnostic.code === "T2O_TRAE_RESOURCE_SCAN_FAILED");
    assert.deepEqual(issue?.subject, { type: "session", sourceId: "session-other" });
    assert.equal(selectBundle(bundle, { session: "session-synthetic" }).diagnostics
      .some((diagnostic) => diagnostic.code === "T2O_TRAE_RESOURCE_SCAN_FAILED"), false);
  });

  it("guards product versions, count evidence and contradictory session reads", () => {
    const options = input();
    assert.throws(() => assembleTraeMigrationBundle({ ...options, productVersion: "0.0.0" }),
      { code: "T2O_TRAE_PROFILE_VERSION_UNSUPPORTED" });
    const read = options.messageReads[0];
    assert.equal(read.status, "available");
    read.expectedMessageCount = -1;
    assert.throws(() => assembleTraeMigrationBundle(options), { code: "T2O_TRAE_BUNDLE_INPUT_INVALID" });
    read.expectedMessageCount = 2;
    options.messageReads = [read, { sourceSessionId: read.sourceSessionId, status: "error" }];
    assert.throws(() => assembleTraeMigrationBundle(options), { code: "T2O_TRAE_BUNDLE_INPUT_INVALID" });
  });

  it("retains runtime-only sessions with null workspace provenance", () => {
    const options = input();
    options.metadata.sessions = [];
    const bundle = assembleTraeMigrationBundle(options);
    assert.equal(bundle.sessions[0].recovery, "partial");
    assert.ok(bundle.sessions[0].sourceRefs.every((ref) => ref.workspaceStorageId === null));
    options.messageReads = [{ sourceSessionId: "session-no-evidence", status: "error" }];
    assert.deepEqual(assembleTraeMigrationBundle(options).sessions, []);
  });

  it("detaches mutable tool payloads and keeps fingerprint independent of collection time", () => {
    const options = input();
    const bundle = assembleTraeMigrationBundle(options);
    toolResult(options).data = { text: "changed" };
    assert.doesNotMatch(JSON.stringify(bundle), /changed/);
    const later = input();
    later.collectedAt = "2026-09-25T00:00:00.000Z";
    assert.equal(assembleTraeMigrationBundle(later).source.sourceFingerprint, bundle.source.sourceFingerprint);
  });

  it("[defect-probing] fingerprints read failures and rejected records", () => {
    const options = input();
    options.messageReads = [{ sourceSessionId: "session-synthetic", status: "unavailable" }];
    const unavailable = assembleTraeMigrationBundle(options).source.sourceFingerprint;
    options.messageReads = [{ sourceSessionId: "session-synthetic", status: "error" }];
    assert.notEqual(assembleTraeMigrationBundle(options).source.sourceFingerprint, unavailable);
    const corrupt = input();
    messages(corrupt).push({ role: "unsupported", content: "rejected-one" });
    const before = assembleTraeMigrationBundle(corrupt).source.sourceFingerprint;
    messages(corrupt)[2].content = "rejected-two";
    assert.notEqual(assembleTraeMigrationBundle(corrupt).source.sourceFingerprint, before);
  });

  it("[defect-probing] a running tool prevents complete recovery", () => {
    const options = input();
    toolResult(options).status = "running";
    const bundle = assembleTraeMigrationBundle(options);
    assert.equal(bundle.sessions[0].recovery, "partial");
    assert.ok(bundle.diagnostics.some((diagnostic) => diagnostic.code === "T2O_IR_CONTENT_INCOMPLETE"));
  });

  it("matches the reviewed parser-to-IR golden fixture", () => {
    const expected = fs.readFileSync("fixtures/ir/v1/golden/valid-trae-assembled.json", "utf8");
    assert.equal(canonicalizeMigrationBundle(assembleTraeMigrationBundle(input())), expected);
  });
});
