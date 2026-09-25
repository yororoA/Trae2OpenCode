import { hashCanonicalJson } from "../../../ir/canonical.js";
import type { JsonObject, JsonValue } from "../../../ir/types.js";
import { Trae2OpenCodeError } from "../../../shared/errors.js";
import { isRecord } from "../contract.js";
import type { OpenCodeTransfer } from "../mapping.js";
import type { OpenCodeReconciliation, TransferCounts } from "../reconciliation.js";
import { assertOpenCodeV1Session } from "./contract.js";

function counts(session: OpenCodeTransfer): TransferCounts {
  const result = {
    messages: session.messages.length, users: 0, assistants: 0, text: 0, reasoning: 0, tools: 0,
  };
  for (const message of session.messages) {
    const info = isRecord(message.info) ? message.info : {};
    if (info.role === "user") result.users++;
    if (info.role !== "assistant") continue;
    result.assistants++;
    for (const part of (Array.isArray(message.parts) ? message.parts : [])) {
      if (!isRecord(part)) continue;
      if (part.type === "text") result.text++;
      if (part.type === "reasoning") result.reasoning++;
      if (part.type === "tool") result.tools++;
    }
  }
  return result;
}

/**
 * v1 derives `projectID` from the importing directory and clears `path`, so neither can
 * be compared; everything else, including the session metadata marker, is byte-compared.
 */
function comparableInfo(session: OpenCodeTransfer): JsonObject {
  const info = structuredClone(session.info);
  delete info.projectID;
  delete info.path;
  return info;
}

function same(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return hashCanonicalJson(left) === hashCanonicalJson(right);
}

/** Validate every nonprojected value; hashes retain array order and JSON types. */
export function reconcileOpenCodeV1Session(
  expectedValue: unknown, actualValue: unknown,
): OpenCodeReconciliation {
  assertOpenCodeV1Session(expectedValue);
  assertOpenCodeV1Session(actualValue);
  const expected = expectedValue as OpenCodeTransfer;
  const actual = actualValue as OpenCodeTransfer;
  const expectedInfo = comparableInfo(expected);
  const actualInfo = comparableInfo(actual);
  const report: OpenCodeReconciliation = {
    status: "verified",
    expected: {
      counts: counts(expected), messagesSha256: hashCanonicalJson(expected.messages),
      infoSha256: hashCanonicalJson(expectedInfo),
    },
    actual: {
      counts: counts(actual), messagesSha256: hashCanonicalJson(actual.messages),
      infoSha256: hashCanonicalJson(actualInfo),
    },
    differences: [], differenceCount: 0, allowedProjections: [],
  };
  const difference = (location: string) => {
    report.differenceCount++;
    if (report.differences.length < 1000) report.differences.push(location);
  };
  for (const key of new Set([...Object.keys(expectedInfo), ...Object.keys(actualInfo)])) {
    if (!same(expectedInfo[key], actualInfo[key])) difference(`info.${key}`);
  }
  if (expected.messages.length !== actual.messages.length) difference("messages.length");
  for (let index = 0; index < Math.max(expected.messages.length, actual.messages.length); index++) {
    if (!same(expected.messages[index], actual.messages[index])) difference(`messages[${index}]`);
  }
  if (!same(expected.info.projectID, actual.info.projectID)) report.allowedProjections.push("info.projectID");
  if (!same(expected.info.path, actual.info.path)) report.allowedProjections.push("info.path");
  if (report.differenceCount > 0) report.status = "mismatch";
  return report;
}

export function requireOpenCodeV1Reconciliation(
  expected: unknown, actual: unknown,
): OpenCodeReconciliation {
  const report = reconcileOpenCodeV1Session(expected, actual);
  if (report.status !== "verified") {
    throw new Trae2OpenCodeError("T2O_OPENCODE_RECONCILIATION_FAILED", {
      diagnostics: [{
        id: hashCanonicalJson(report as unknown as JsonValue),
        code: "T2O_OPENCODE_RECONCILIATION_FAILED",
        message: "The imported OpenCode 1.x transcript differs from the planned transfer.",
        severity: "error", sourceRefs: [], subject: { type: "bundle" },
        context: { differenceCount: report.differenceCount, locations: report.differences },
      }],
    });
  }
  return report;
}