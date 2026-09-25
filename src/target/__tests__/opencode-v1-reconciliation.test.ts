import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonObject, MigrationBundle } from "../../ir/types.js";
import { reconcileOpenCodeV1Session, requireOpenCodeV1Reconciliation } from "../opencode/v1/reconciliation.js";
import { mapOpenCodeV1Session, type OpenCodeV1Session } from "../opencode/v1/mapping.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../../../fixtures/ir/v1/valid-trae-assembled.json", import.meta.url,
), "utf8")) as MigrationBundle;

function expected(): OpenCodeV1Session {
  return mapOpenCodeV1Session(fixture, "session-synthetic", {
    sessionId: "ses_v1_reconcile",
    messageIds: new Map([["user-synthetic", "msg_0001_user"], ["assistant-synthetic", "msg_0002_assistant"]]),
    directory: "/synthetic/target",
    targetVersion: "1.18.32",
  }).transfer;
}

/** v1 derives these two fields from the importing directory instead of the payload. */
function asReadback(value: OpenCodeV1Session): OpenCodeV1Session {
  const clone = structuredClone(value);
  clone.info.projectID = "derived-from-directory";
  clone.info.path = "Users/synthetic/target";
  return clone;
}

describe("OpenCode v1 readback reconciliation", () => {
  it("verifies a readback that only differs in v1's own directory projections", () => {
    const planned = expected();
    const report = reconcileOpenCodeV1Session(planned, asReadback(planned));
    assert.equal(report.status, "verified");
    assert.equal(report.differenceCount, 0);
    assert.deepEqual(report.allowedProjections.sort(), ["info.path", "info.projectID"]);
    assert.deepEqual(report.expected.counts, {
      messages: 2, users: 1, assistants: 1, text: 2, reasoning: 2, tools: 1,
    });
    assert.equal(report.expected.messagesSha256, report.actual.messagesSha256);
  });

  it("detects a dropped part, reordered parts, a changed text and a changed session marker", () => {
    const planned = expected();
    const cases: Array<(value: OpenCodeV1Session) => void> = [
      (value) => { (value.messages[1].parts as JsonObject[]).splice(0, 1); },
      (value) => {
        const parts = value.messages[1].parts as JsonObject[];
        [parts[0], parts[1]] = [parts[1]!, parts[0]!];
      },
      (value) => { (value.messages[1].parts as JsonObject[])[4].text = "changed"; },
      (value) => { (value.info.metadata as JsonObject).trae2opencode = { mappingVersion: 8 }; },
      (value) => { (value.messages[0].info as JsonObject).time = { created: 1 }; },
    ];
    for (const mutate of cases) {
      const actual = asReadback(planned);
      mutate(actual);
      const report = reconcileOpenCodeV1Session(planned, actual);
      assert.equal(report.status, "mismatch");
      assert.ok(report.differenceCount > 0);
      assert.throws(() => requireOpenCodeV1Reconciliation(planned, actual),
        { code: "T2O_OPENCODE_RECONCILIATION_FAILED" });
    }
  });

  it("ignores object key order and never echoes payload values in the report", () => {
    const planned = expected();
    const actual = asReadback(planned);
    assert.equal(reconcileOpenCodeV1Session(planned, actual).status, "verified");
    const report = reconcileOpenCodeV1Session(planned, { ...actual, messages: [] });
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes("First persisted reasoning"));
    assert.ok(!serialized.includes("/synthetic/target"));
    assert.deepEqual(report.differences, ["messages.length", "messages[0]", "messages[1]"]);
    assert.equal(report.expected.infoSha256, hashCanonicalJson(
      (() => { const clone = structuredClone(planned.info); delete clone.projectID; delete clone.path; return clone; })(),
    ));
  });

  it("rejects a payload that violates the reviewed v1 contract before reporting", () => {
    const planned = expected();
    const actual = asReadback(planned);
    (actual.messages[1].parts as JsonObject[])[0].time = {};
    assert.throws(() => reconcileOpenCodeV1Session(planned, actual),
      { code: "T2O_OPENCODE_TRANSFER_INVALID" });
  });
});