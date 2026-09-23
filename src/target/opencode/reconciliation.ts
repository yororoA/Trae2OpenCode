import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonObject, JsonValue } from "../../ir/types.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import { assertOpenCodeTransfer, isRecord } from "./contract.js";
import type { OpenCodeTransfer } from "./mapping.js";

export interface TransferCounts {
  messages: number;
  users: number;
  assistants: number;
  text: number;
  reasoning: number;
  tools: number;
}

export interface OpenCodeReconciliation {
  status: "verified" | "mismatch";
  expected: { counts: TransferCounts; messagesSha256: string; infoSha256: string };
  actual: { counts: TransferCounts; messagesSha256: string; infoSha256: string };
  /** Fixed field names and numeric indices only; never payload keys or values. */
  differences: string[];
  differenceCount: number;
  allowedProjections: string[];
}

function counts(transfer: OpenCodeTransfer): TransferCounts {
  const result = { messages: transfer.messages.length, users: 0, assistants: 0, text: 0, reasoning: 0, tools: 0 };
  for (const message of transfer.messages) {
    if (message.type === "user") result.users++;
    if (message.type !== "assistant") continue;
    result.assistants++;
    for (const block of message.content as JsonObject[]) {
      if (block.type === "text") result.text++;
      if (block.type === "reasoning") result.reasoning++;
      if (block.type === "tool") result.tools++;
    }
  }
  return result;
}

function comparableInfo(transfer: OpenCodeTransfer): JsonObject {
  const info = structuredClone(transfer.info);
  delete info.projectID;
  delete info.subpath;
  delete (info.time as JsonObject).updated;
  if (isRecord(info.model)) delete info.model.variant;
  return info;
}

function same(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return hashCanonicalJson(left) === hashCanonicalJson(right);
}

/** Validate every nonprojected value. Hash comparisons retain array order and JSON types. */
export function reconcileOpenCodeTransfer(expectedValue: unknown, actualValue: unknown): OpenCodeReconciliation {
  assertOpenCodeTransfer(expectedValue);
  assertOpenCodeTransfer(actualValue);
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
    // Bound report memory even if a very large transcript is completely different.
    if (report.differences.length < 1000) report.differences.push(location);
  };
  for (const key of new Set([...Object.keys(expectedInfo), ...Object.keys(actualInfo)])) {
    if (!same(expectedInfo[key], actualInfo[key])) difference(`info.${key}`);
  }
  if (expected.messages.length !== actual.messages.length) difference("messages.length");
  for (let index = 0; index < Math.max(expected.messages.length, actual.messages.length); index++) {
    const left = expected.messages[index];
    const right = actual.messages[index];
    if (!same(left, right)) difference(`messages[${index}]`);
  }
  if (!same(expected.info.projectID, actual.info.projectID)) report.allowedProjections.push("info.projectID");
  if (!same(expected.info.subpath, actual.info.subpath)) report.allowedProjections.push("info.subpath");
  if (expected.info.time.updated !== actual.info.time.updated) report.allowedProjections.push("info.time.updated");
  const expectedModel = expected.info.model as JsonObject | undefined;
  const actualModel = actual.info.model as JsonObject | undefined;
  if (!same(expectedModel?.variant, actualModel?.variant)) report.allowedProjections.push("info.model.variant");
  if (report.differenceCount > 0) report.status = "mismatch";
  return report;
}

export function requireOpenCodeReconciliation(expected: unknown, actual: unknown): OpenCodeReconciliation {
  const report = reconcileOpenCodeTransfer(expected, actual);
  if (report.status !== "verified") {
    throw new Trae2OpenCodeError("T2O_OPENCODE_RECONCILIATION_FAILED", {
      diagnostics: [{
        id: hashCanonicalJson(report as unknown as JsonValue),
        code: "T2O_OPENCODE_RECONCILIATION_FAILED",
        message: "The target transcript differs from the planned transfer.",
        severity: "error", sourceRefs: [], subject: { type: "bundle" },
        context: { differenceCount: report.differenceCount, locations: report.differences },
      }],
    });
  }
  return report;
}
