import { createHash } from "node:crypto";
import { assertTraeParserCapability, RUNTIME_PROFILE } from "./profile-definitions.js";

export interface TraeContentSource {
  locator: string;
  sha256: string;
}

export interface TraeReasoningBlock {
  text: string;
  /** Position in the persisted envelope; -1 denotes the general envelope. */
  entryIndex: number;
  sourcePlanItemId?: string;
  source: TraeContentSource;
}

export interface TraePlanItem {
  sourcePlanItemId: string;
  entryIndex: number;
  thought?: { chars: number; source: TraeContentSource };
  source: TraeContentSource;
}

export type TraeReasoningPlanIssueCode =
  | "T2O_TRAE_REASONING_INVALID"
  | "T2O_TRAE_PLAN_ITEM_INVALID"
  | "T2O_TRAE_PLAN_ITEM_CONFLICT"
  | "T2O_TRAE_PLAN_THOUGHT_UNMAPPED"
  | "T2O_TRAE_CONTENT_TYPE_UNSUPPORTED";

export interface TraeReasoningPlanIssue {
  code: TraeReasoningPlanIssueCode;
  severity: "warning" | "error";
  message: string;
  contentLocator: string;
}

export interface TraeReasoningPlanReport {
  reasoningBlocks: TraeReasoningBlock[];
  planItems: TraePlanItem[];
  issues: TraeReasoningPlanIssue[];
}

export function isRuntimeObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseRuntimeObject(value: unknown): Record<string, unknown> | null {
  if (isRuntimeObject(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRuntimeObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Canonical object keys with array order retained; cycles are rejected. */
export function runtimeHash(value: unknown): string {
  const ancestors = new Set<object>();
  function canonical(item: unknown): string {
    if (item === undefined) return "undefined";
    if (item === null || typeof item !== "object") {
      return JSON.stringify(item) ?? "undefined";
    }
    if (ancestors.has(item)) throw new TypeError("Cyclic runtime value.");
    ancestors.add(item);
    const result = Array.isArray(item)
      ? `[${item.map(canonical).join(",")}]`
      : `{${Object.entries(item)
          .filter(([, field]) => field !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`)
          .join(",")}}`;
    ancestors.delete(item);
    return result;
  }
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

const MESSAGES: Record<TraeReasoningPlanIssueCode, string> = {
  T2O_TRAE_REASONING_INVALID: "A persisted TRAE reasoning field is invalid.",
  T2O_TRAE_PLAN_ITEM_INVALID: "A persisted TRAE plan item is invalid.",
  T2O_TRAE_PLAN_ITEM_CONFLICT: "Conflicting TRAE plan items share an identifier.",
  T2O_TRAE_PLAN_THOUGHT_UNMAPPED: "A persisted plan thought has no verified content mapping.",
  T2O_TRAE_CONTENT_TYPE_UNSUPPORTED: "A persisted assistant content type is unsupported.",
};

export function parseTraeReasoningPlan(
  value: unknown,
  messageType: "general" | "task",
  productVersion: string,
  mappedTextLocators: readonly string[] = [],
): TraeReasoningPlanReport {
  assertTraeParserCapability(productVersion, RUNTIME_PROFILE, "reasoning-plan", "T2O_TRAE_ASSISTANT_MESSAGE_VERSION_UNSUPPORTED");
  const report: TraeReasoningPlanReport = {
    reasoningBlocks: [],
    planItems: [],
    issues: [],
  };
  const issue = (
    code: TraeReasoningPlanIssueCode,
    contentLocator: string,
    severity: "warning" | "error" = "error",
  ) => report.issues.push({ code, severity, message: MESSAGES[code], contentLocator });
  const readReasoning = (
    field: unknown,
    locator: string,
    entryIndex: number,
    sourcePlanItemId?: string,
  ) => {
    const isAbsent = field === undefined || field === null || field === "";
    if (isAbsent) return;
    if (typeof field !== "string") {
      issue("T2O_TRAE_REASONING_INVALID", locator);
      return;
    }
    if (field.trim().length === 0) return;
    report.reasoningBlocks.push({
      text: field,
      entryIndex,
      ...(sourcePlanItemId ? { sourcePlanItemId } : {}),
      source: { locator, sha256: runtimeHash(field) },
    });
  };

  const envelope = parseRuntimeObject(value);
  if (!envelope) {
    issue("T2O_TRAE_REASONING_INVALID", "content");
    return report;
  }
  if (messageType === "general") {
    readReasoning(envelope.reasoning_content, "content.reasoning_content", -1);
    return report;
  }
  if (!Array.isArray(envelope.messages)) {
    issue("T2O_TRAE_PLAN_ITEM_INVALID", "content.messages");
    return report;
  }

  const seen = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const [entryIndex, entry] of envelope.messages.entries()) {
    const locator = `content.messages[${entryIndex}]`;
    if (!isRuntimeObject(entry)) {
      issue("T2O_TRAE_PLAN_ITEM_INVALID", locator);
      continue;
    }
    if (entry.type === "proposal") {
      const proposal = parseRuntimeObject(entry.proposal);
      const content = proposal && parseRuntimeObject(proposal.content);
      if (!content) {
        issue("T2O_TRAE_REASONING_INVALID", `${locator}.proposal.content`);
        continue;
      }
      readReasoning(content.reasoning_content, `${locator}.proposal.content.reasoning_content`, entryIndex);
      continue;
    }
    if (entry.type !== "plan_item") {
      // Agent-call metadata has no verified reasoning projection yet.
      issue("T2O_TRAE_CONTENT_TYPE_UNSUPPORTED", locator, "warning");
      continue;
    }
    const item = entry.plan_item;
    const itemLocator = `${locator}.plan_item`;
    const hasValidIdentity =
      isRuntimeObject(item) &&
      typeof item.id === "string" &&
      /^[A-Za-z0-9._:-]{1,256}$/.test(item.id);
    if (!hasValidIdentity) {
      issue("T2O_TRAE_PLAN_ITEM_INVALID", itemLocator);
      continue;
    }
    const sourcePlanItemId = item.id as string;
    if (conflicted.has(sourcePlanItemId)) continue;
    let hash: string;
    try {
      hash = runtimeHash(item);
    } catch {
      issue("T2O_TRAE_PLAN_ITEM_INVALID", itemLocator);
      continue;
    }
    const previous = seen.get(sourcePlanItemId);
    if (previous === hash) continue;
    if (previous !== undefined) {
      conflicted.add(sourcePlanItemId);
      issue("T2O_TRAE_PLAN_ITEM_CONFLICT", itemLocator);
      continue;
    }
    seen.set(sourcePlanItemId, hash);
    const plan: TraePlanItem = {
      sourcePlanItemId,
      entryIndex,
      source: { locator: itemLocator, sha256: hash },
    };
    readReasoning(item.reasoning_content, `${itemLocator}.reasoning_content`, entryIndex, sourcePlanItemId);
    const hasThought = typeof item.thought === "string" && item.thought.trim().length > 0;
    if (hasThought) {
      const thoughtLocator = `${itemLocator}.thought`;
      plan.thought = {
        chars: (item.thought as string).length,
        source: { locator: thoughtLocator, sha256: runtimeHash(item.thought) },
      };
      if (!mappedTextLocators.includes(thoughtLocator)) {
        issue("T2O_TRAE_PLAN_THOUGHT_UNMAPPED", thoughtLocator, "warning");
      }
    } else if (item.thought !== undefined && item.thought !== null && typeof item.thought !== "string") {
      issue("T2O_TRAE_PLAN_ITEM_INVALID", `${itemLocator}.thought`);
    }
    report.planItems.push(plan);
  }
  report.planItems = report.planItems.filter((item) => !conflicted.has(item.sourcePlanItemId));
  report.reasoningBlocks = report.reasoningBlocks.filter(
    (block) => !block.sourcePlanItemId || !conflicted.has(block.sourcePlanItemId),
  );
  return report;
}
