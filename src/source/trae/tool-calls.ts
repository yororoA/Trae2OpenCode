import type { JsonValue, ToolStatus } from "../../ir/types.js";
import { assertTraeParserCapability, RUNTIME_PROFILE } from "./profile-definitions.js";
import {
  isRuntimeObject,
  parseRuntimeObject,
  runtimeHash,
  type TraeContentSource,
} from "./reasoning-plan.js";

export interface TraeToolCall {
  callId: string;
  name: string;
  input: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  status: ToolStatus;
  entryIndex: number;
  generatedAt?: number;
  startedAt?: number;
  completedAt?: number;
  sources: TraeContentSource[];
}

export type TraeToolIssueCode =
  | "T2O_TRAE_TOOL_CONTAINER_INVALID"
  | "T2O_TRAE_TOOL_CALL_INVALID"
  | "T2O_TRAE_TOOL_INPUT_INVALID"
  | "T2O_TRAE_TOOL_RESULT_INVALID"
  | "T2O_TRAE_TOOL_RESULT_MISSING"
  | "T2O_TRAE_TOOL_ERROR_UNVERIFIED"
  | "T2O_TRAE_TOOL_STATUS_UNSUPPORTED"
  | "T2O_TRAE_TOOL_TIMING_INVALID"
  | "T2O_TRAE_TOOL_CONFLICT";

export interface TraeToolIssue {
  code: TraeToolIssueCode;
  severity: "warning" | "error";
  message: string;
  contentLocator: string;
}

export interface TraeToolReport {
  toolCalls: TraeToolCall[];
  issues: TraeToolIssue[];
}

const MESSAGES: Record<TraeToolIssueCode, string> = {
  T2O_TRAE_TOOL_CONTAINER_INVALID: "A TRAE tool container is invalid.",
  T2O_TRAE_TOOL_CALL_INVALID: "A TRAE tool call has no valid identity or name.",
  T2O_TRAE_TOOL_INPUT_INVALID: "A TRAE tool input is missing or invalid.",
  T2O_TRAE_TOOL_RESULT_INVALID: "A TRAE tool result payload is invalid.",
  T2O_TRAE_TOOL_RESULT_MISSING: "A TRAE tool call has no persisted result.",
  T2O_TRAE_TOOL_ERROR_UNVERIFIED: "A TRAE tool error payload requires content-level verification before import.",
  T2O_TRAE_TOOL_STATUS_UNSUPPORTED: "A TRAE tool status has no verified target mapping.",
  T2O_TRAE_TOOL_TIMING_INVALID: "A TRAE tool timing field is invalid or inconsistent.",
  T2O_TRAE_TOOL_CONFLICT: "Conflicting TRAE tool observations share a call identifier.",
};

/** Copy JSON values without mutating source params or invoking JSON toJSON hooks. */
function jsonValue(value: unknown, ancestors = new Set<object>()): JsonValue {
  const isPrimitive = value === null || typeof value === "string" || typeof value === "boolean";
  if (isPrimitive) return value as null | string | boolean;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new TypeError("Invalid JSON value.");
  }
  const prototype = Object.getPrototypeOf(value);
  const isPlainObject = prototype === Object.prototype || prototype === null;
  if (!Array.isArray(value) && !isPlainObject) throw new TypeError("Invalid JSON object.");
  const next = new Set(ancestors).add(value);
  return Array.isArray(value)
    ? value.map((item) => jsonValue(item, next))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, next)]));
}

function toolStatus(value: unknown): ToolStatus {
  if (value === "success") return "completed";
  if (value === "failed") return "error";
  if (value === "running") return "running";
  return "unknown";
}

function isTerminal(call: TraeToolCall): boolean {
  return call.status === "completed" || call.status === "error";
}

export function parseTraeToolCalls(
  value: unknown,
  messageType: "general" | "task",
  productVersion: string,
): TraeToolReport {
  assertTraeParserCapability(productVersion, RUNTIME_PROFILE, "tool-calls", "T2O_TRAE_ASSISTANT_MESSAGE_VERSION_UNSUPPORTED");
  const report: TraeToolReport = { toolCalls: [], issues: [] };
  if (messageType === "general") return report;
  const issue = (
    code: TraeToolIssueCode,
    contentLocator: string,
    severity: "warning" | "error" = "error",
  ) => report.issues.push({ code, contentLocator, severity, message: MESSAGES[code] });
  const envelope = parseRuntimeObject(value);
  if (!envelope || !Array.isArray(envelope.messages)) {
    issue("T2O_TRAE_TOOL_CONTAINER_INVALID", "content.messages");
    return report;
  }
  const accepted = new Map<string, TraeToolCall>();
  const conflicted = new Set<string>();
  const invalidate = (callId: string, locator: string) => {
    accepted.delete(callId);
    conflicted.add(callId);
    issue("T2O_TRAE_TOOL_CONFLICT", locator);
  };

  for (const [entryIndex, entry] of envelope.messages.entries()) {
    if (!isRuntimeObject(entry) || entry.type !== "plan_item") continue;
    const item = entry.plan_item;
    const locator = `content.messages[${entryIndex}].plan_item.tool_call_info`;
    if (!isRuntimeObject(item)) {
      issue("T2O_TRAE_TOOL_CALL_INVALID", locator);
      continue;
    }
    const raw = item.tool_call_info;
    // A reasoning-only plan item is not an orphan tool call.
    if (raw === undefined || raw === null) continue;
    const hasValidCall =
      isRuntimeObject(raw) &&
      typeof raw.id === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(raw.id) &&
      typeof raw.name === "string" && raw.name.trim().length > 0;
    if (!hasValidCall) {
      issue("T2O_TRAE_TOOL_CALL_INVALID", locator);
      continue;
    }
    const callId = raw.id as string;
    if (conflicted.has(callId)) continue;
    let input: JsonValue;
    let hash: string;
    try {
      input = jsonValue(raw.params);
      hash = runtimeHash(raw);
    } catch {
      issue("T2O_TRAE_TOOL_INPUT_INVALID", `${locator}.params`);
      accepted.delete(callId);
      conflicted.add(callId);
      continue;
    }

    const result = raw.result;
    const call: TraeToolCall = {
      callId,
      name: raw.name as string,
      input,
      entryIndex,
      status: "unknown",
      sources: [{ locator, sha256: hash }],
    };
    if (result === undefined || result === null) {
      issue("T2O_TRAE_TOOL_RESULT_MISSING", `${locator}.result`, "warning");
    } else if (!isRuntimeObject(result)) {
      issue("T2O_TRAE_TOOL_RESULT_INVALID", `${locator}.result`);
      accepted.delete(callId);
      conflicted.add(callId);
      continue;
    } else {
      call.status = toolStatus(result.status);
      if (call.status === "unknown") {
        issue("T2O_TRAE_TOOL_STATUS_UNSUPPORTED", `${locator}.result.status`, "warning");
      }
      try {
        if (result.data !== undefined) call.output = jsonValue(result.data);
        const hasError = result.error_message !== undefined && result.error_message !== null && result.error_message !== "";
        if (hasError) {
          call.error = jsonValue(result.error_message);
          issue("T2O_TRAE_TOOL_ERROR_UNVERIFIED", `${locator}.result.error_message`, "warning");
        }
      } catch {
        issue("T2O_TRAE_TOOL_RESULT_INVALID", `${locator}.result`);
        accepted.delete(callId);
        conflicted.add(callId);
        continue;
      }
    }

    const timing = item.timing;
    if (timing !== undefined && timing !== null && !isRuntimeObject(timing)) {
      issue("T2O_TRAE_TOOL_TIMING_INVALID", `content.messages[${entryIndex}].plan_item.timing`);
    } else if (isRuntimeObject(timing)) {
      const fields = [
        ["generated_at_ms", "generatedAt"],
        ["tool_call_started_at_ms", "startedAt"],
        ["tool_call_finished_at_ms", "completedAt"],
      ] as const;
      for (const [rawField, field] of fields) {
        const timestamp = timing[rawField];
        if (timestamp === undefined || timestamp === null) continue;
        const valid = typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp >= 0;
        if (valid) call[field] = timestamp;
        else issue("T2O_TRAE_TOOL_TIMING_INVALID", `content.messages[${entryIndex}].plan_item.timing.${rawField}`);
      }
      const baseline = call.startedAt ?? call.generatedAt;
      const endPrecedesStart = call.completedAt !== undefined && baseline !== undefined && call.completedAt < baseline;
      if (endPrecedesStart) {
        delete call.completedAt;
        issue("T2O_TRAE_TOOL_TIMING_INVALID", `content.messages[${entryIndex}].plan_item.timing`);
      }
    }

    const previous = accepted.get(callId);
    if (!previous) {
      accepted.set(callId, call);
      continue;
    }
    const identityConflict = previous.name !== call.name || runtimeHash(previous.input) !== runtimeHash(call.input);
    const bothTerminal = isTerminal(previous) && isTerminal(call);
    const terminalConflict = bothTerminal && runtimeHash({
      status: previous.status, output: previous.output, error: previous.error,
    }) !== runtimeHash({ status: call.status, output: call.output, error: call.error });
    const timingConflict = (["generatedAt", "startedAt", "completedAt"] as const).some(
      (field) => previous[field] !== undefined && call[field] !== undefined && previous[field] !== call[field],
    );
    if (identityConflict || terminalConflict || timingConflict) {
      invalidate(callId, locator);
      continue;
    }
    // Terminal evidence wins even when observations arrive out of order.
    const chooseCurrent = isTerminal(call) || (!isTerminal(previous) && call.status === "running");
    const merged = chooseCurrent ? call : previous;
    merged.entryIndex = Math.min(previous.entryIndex, call.entryIndex);
    merged.sources = [...previous.sources, ...call.sources];
    for (const field of ["generatedAt", "startedAt", "completedAt"] as const) {
      const time = previous[field] ?? call[field];
      if (time !== undefined) merged[field] = time;
    }
    const mergedStart = merged.startedAt ?? merged.generatedAt;
    const invalidMergedTime = merged.completedAt !== undefined &&
      mergedStart !== undefined && merged.completedAt < mergedStart;
    if (invalidMergedTime) {
      invalidate(callId, locator);
      continue;
    }
    accepted.set(callId, merged);
  }
  report.toolCalls = [...accepted.values()].sort(
    (left, right) => left.entryIndex - right.entryIndex || left.callId.localeCompare(right.callId),
  );
  return report;
}
