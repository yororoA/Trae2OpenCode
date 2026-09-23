import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { validateMigrationBundleIntegrity } from "../integrity.js";
import type { MigrationBundle } from "../types.js";

function input(): MigrationBundle {
  return JSON.parse(fs.readFileSync("fixtures/ir/v1/valid-complete.json", "utf8"));
}
function codes(bundle: MigrationBundle): string[] {
  return validateMigrationBundleIntegrity(bundle).map((diagnostic) => diagnostic.code);
}

describe("validateMigrationBundleIntegrity", () => {
  it("accepts a valid bundle without mutating it and rejects invalid schema first", () => {
    const bundle = input();
    const before = structuredClone(bundle);
    assert.deepEqual(validateMigrationBundleIntegrity(bundle), []);
    assert.deepEqual(bundle, before);
    assert.throws(() => validateMigrationBundleIntegrity({}), { code: "T2O_IR_SCHEMA_INVALID" });
  });

  it("detects duplicate identities and broken project/parent references", () => {
    const bundle = input();
    bundle.projects.push(structuredClone(bundle.projects[0]));
    bundle.sessions[0].projectSourceId = "absent-project";
    bundle.sessions[0].parentSourceId = "absent-session";
    bundle.sessions.push(structuredClone(bundle.sessions[0]));
    assert.deepEqual(new Set(codes(bundle)), new Set([
      "T2O_IR_PROJECT_ID_CONFLICT", "T2O_IR_SESSION_ID_CONFLICT",
      "T2O_IR_PROJECT_REFERENCE_MISSING", "T2O_IR_PARENT_REFERENCE_MISSING",
    ]));
  });

  it("detects cycles without treating a descendant as part of the cycle", () => {
    const bundle = input();
    const template = bundle.sessions[0];
    bundle.sessions = [
      { ...template, sourceId: "descendant", parentSourceId: "parent-a", events: [] },
      { ...template, sourceId: "parent-a", parentSourceId: "parent-b", events: [] },
      { ...template, sourceId: "parent-b", parentSourceId: "parent-a", events: [] },
    ];
    assert.deepEqual(
      validateMigrationBundleIntegrity(bundle).filter((issue) => issue.code === "T2O_IR_PARENT_CYCLE")
        .map((issue) => issue.subject?.sourceId).sort(),
      ["parent-a", "parent-b"],
    );
  });

  it("walks a deep parent chain iteratively", () => {
    const bundle = input();
    const template = bundle.sessions[0];
    bundle.sessions = Array.from({ length: 2000 }, (_, index) => ({
      ...template, sourceId: `session-${index}`, events: [],
      ...(index === 1999 ? {} : { parentSourceId: `session-${index + 1}` }),
    }));
    assert.deepEqual(validateMigrationBundleIntegrity(bundle), []);
  });

  it("rejects duplicate event IDs/order, foreign provenance and forward replies", () => {
    const bundle = input();
    const session = bundle.sessions[0];
    const assistant = session.events[1];
    assert.equal(assistant.type, "assistant");
    session.events[0].order = 3;
    assistant.sourceRefs[0].sourceSessionId = "foreign-session";
    session.events.push(structuredClone(session.events[0]));
    const actual = codes(bundle);
    for (const code of ["T2O_IR_EVENT_ID_CONFLICT", "T2O_IR_EVENT_ORDER_CONFLICT",
      "T2O_IR_EVENT_SOURCE_MISMATCH", "T2O_IR_REPLY_REFERENCE_INVALID"]) assert.ok(actual.includes(code), code);
    assert.doesNotMatch(JSON.stringify(validateMigrationBundleIntegrity(bundle)), /Persisted reasoning fixture|Preserve Unicode/);
  });

  it("checks content times, source sessions, duplicate tool calls and resources", () => {
    const bundle = input();
    const session = bundle.sessions[0];
    session.updatedAt = 0;
    const assistant = session.events[1];
    assert.equal(assistant.type, "assistant");
    assistant.completedAt = 0;
    assistant.content[0].completedAt = 0;
    assistant.content[0].sourceRefs[0].sourceSessionId = "foreign-session";
    assistant.content.push(structuredClone(assistant.content[1]));
    const resource = {
      sourceId: "duplicate-resource", type: "file" as const, availability: "missing" as const,
      sourceRefs: structuredClone(session.sourceRefs),
    };
    session.resources = [resource, structuredClone(resource)];
    const actual = codes(bundle);
    for (const code of ["T2O_IR_SESSION_TIME_INVALID", "T2O_IR_EVENT_TIME_INVALID", "T2O_IR_CONTENT_TIME_INVALID",
      "T2O_IR_CONTENT_SOURCE_MISMATCH", "T2O_IR_TOOL_ID_CONFLICT", "T2O_IR_RESOURCE_ID_CONFLICT"]) {
      assert.ok(actual.includes(code), code);
    }
  });
});
