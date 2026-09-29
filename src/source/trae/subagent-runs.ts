import { assertTraeParserCapability, RUNTIME_PROFILE } from "./profile-definitions.js";
import {
  isRuntimeObject,
  parseRuntimeObject,
  runtimeHash,
  type TraeContentSource,
} from "./reasoning-plan.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

export type TraeSubagentRunIssueCode =
  | "T2O_TRAE_SUBAGENT_RUN_INVALID"
  | "T2O_TRAE_SUBAGENT_RUN_CONFLICT"
  | "T2O_TRAE_SUBAGENT_RUN_INCOMPLETE";

export interface TraeSubagentRunIssue {
  code: TraeSubagentRunIssueCode;
  severity: "warning";
  message: string;
  contentLocator: string;
}

export interface TraeSubagentRun {
  sourceRunId: string;
  parentRunIds: string[];
  agentId: string;
  agentDisplayName?: string;
  description: string;
  runMode?: "foreground" | "background";
  entryIndexes: number[];
  responseEntryIndex?: number;
  createdAt: number;
  completedAt: number;
  sources: TraeContentSource[];
}

export interface TraeSubagentRunReport {
  runs: TraeSubagentRun[];
  issues: TraeSubagentRunIssue[];
}

interface Candidate {
  sourceRunId: string;
  parentRunIds?: string[];
  agentId?: string;
  agentDisplayName?: string;
  description?: string;
  runMode?: "foreground" | "background";
  entryIndexes: number[];
  responseEntryIndexes: number[];
  times: number[];
  completedTimes: number[];
  completed: boolean;
  sources: TraeContentSource[];
  conflict: boolean;
}

const MESSAGES: Record<TraeSubagentRunIssueCode, string> = {
  T2O_TRAE_SUBAGENT_RUN_INVALID:
    "A TRAE subagent record has an invalid run, parent, agent, or timing field.",
  T2O_TRAE_SUBAGENT_RUN_CONFLICT:
    "Conflicting TRAE subagent records share a run identifier.",
  T2O_TRAE_SUBAGENT_RUN_INCOMPLETE:
    "A TRAE subagent run lacks the verified description or completed state required for reconstruction.",
};

function parseIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value)
    ? value
    : undefined;
}

function parseTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * TRAE persists subagent work inline with the parent assistant message. A run is
 * reconstructable only when its parent path, identity, description and terminal
 * state agree across all observed plan items.
 */
export function parseTraeSubagentRuns(
  value: unknown,
  messageType: "general" | "task",
  productVersion: string,
): TraeSubagentRunReport {
  assertTraeParserCapability(
    productVersion,
    RUNTIME_PROFILE,
    "subagent-runs",
    "T2O_TRAE_ASSISTANT_MESSAGE_VERSION_UNSUPPORTED",
  );
  const report: TraeSubagentRunReport = { runs: [], issues: [] };
  if (messageType === "general") return report;
  const envelope = parseRuntimeObject(value);
  if (!envelope || !Array.isArray(envelope.messages)) return report;
  const candidates = new Map<string, Candidate>();
  const issue = (
    code: TraeSubagentRunIssueCode,
    contentLocator: string,
  ) => report.issues.push({
    code,
    contentLocator,
    severity: "warning",
    message: MESSAGES[code],
  });

  for (const [entryIndex, entry] of envelope.messages.entries()) {
    if (!isRuntimeObject(entry) || entry.type !== "plan_item" ||
      !isRuntimeObject(entry.plan_item)) continue;
    const item = entry.plan_item;
    const hasSubagentEvidence =
      Array.isArray(item.parent_agent_run_ids) && item.parent_agent_run_ids.length > 0 ||
      typeof item.sub_agent_call_description === "string" &&
        item.sub_agent_call_description.trim().length > 0;
    if (!hasSubagentEvidence) continue;
    const locator = `content.messages[${entryIndex}].plan_item`;
    const sourceRunId = parseIdentifier(item.agent_run_id);
    const parentRunIds = Array.isArray(item.parent_agent_run_ids)
      ? item.parent_agent_run_ids.map(parseIdentifier)
      : [];
    const validParents = sourceRunId !== undefined &&
      parentRunIds.length > 0 &&
      parentRunIds.every((parent): parent is string => parent !== undefined) &&
      new Set(parentRunIds).size === parentRunIds.length &&
      !parentRunIds.includes(sourceRunId);
    if (!sourceRunId || !validParents) {
      issue("T2O_TRAE_SUBAGENT_RUN_INVALID", locator);
      continue;
    }
    const normalizedParents = parentRunIds as string[];
    const agentId = parseIdentifier(item.agent_id);
    const agentDisplayName = typeof item.agent_display_name === "string" &&
      item.agent_display_name.trim().length > 0
      ? item.agent_display_name
      : undefined;
    const description = typeof item.sub_agent_call_description === "string" &&
      item.sub_agent_call_description.trim().length > 0
      ? item.sub_agent_call_description
      : undefined;
    const status = isRuntimeObject(item.agent_status) ? item.agent_status.status : undefined;
    const runModeValue = isRuntimeObject(item.agent_status)
      ? item.agent_status.run_mode
      : undefined;
    const runMode = runModeValue === "foreground" || runModeValue === "background"
      ? runModeValue
      : undefined;
    const timing = isRuntimeObject(item.timing) ? item.timing : undefined;
    const tool = isRuntimeObject(item.tool_call_info) ? item.tool_call_info : undefined;
    const isTerminalText =
      status === "completed" &&
      tool?.name === "" &&
      typeof item.thought === "string" &&
      item.thought.trim().length > 0;
    const times = timing
      ? [
          parseTime(timing.generated_at_ms),
          parseTime(timing.tool_call_started_at_ms),
          parseTime(timing.tool_call_finished_at_ms),
        ].filter((time): time is number => time !== undefined)
      : [];
    if (!agentId || (status !== undefined && status !== "running" && status !== "completed") ||
      (runModeValue !== undefined && runMode === undefined) ||
      (timing !== undefined && times.length === 0)) {
      issue("T2O_TRAE_SUBAGENT_RUN_INVALID", locator);
      continue;
    }
    const source = { locator, sha256: runtimeHash(item) };
    const current = candidates.get(sourceRunId);
    if (!current) {
      candidates.set(sourceRunId, {
        sourceRunId,
        parentRunIds: normalizedParents,
        agentId,
        ...(agentDisplayName ? { agentDisplayName } : {}),
        ...(description ? { description } : {}),
        ...(runMode ? { runMode } : {}),
        entryIndexes: [entryIndex],
        responseEntryIndexes: isTerminalText ? [entryIndex] : [],
        times,
        completedTimes: status === "completed" ? times : [],
        completed: status === "completed",
        sources: [source],
        conflict: false,
      });
      continue;
    }
    const conflict =
      current.agentId !== agentId ||
      !sameStrings(current.parentRunIds ?? [], normalizedParents) ||
      (description !== undefined && current.description !== undefined &&
        current.description !== description) ||
      (agentDisplayName !== undefined && current.agentDisplayName !== undefined &&
        current.agentDisplayName !== agentDisplayName) ||
      (runMode !== undefined && current.runMode !== undefined && current.runMode !== runMode);
    if (conflict) {
      current.conflict = true;
      issue("T2O_TRAE_SUBAGENT_RUN_CONFLICT", locator);
      continue;
    }
    current.description ??= description;
    current.agentDisplayName ??= agentDisplayName;
    current.runMode ??= runMode;
    current.entryIndexes.push(entryIndex);
    if (isTerminalText) current.responseEntryIndexes.push(entryIndex);
    current.times.push(...times);
    if (status === "completed") {
      current.completed = true;
      current.completedTimes.push(...times);
    }
    current.sources.push(source);
  }

  for (const candidate of candidates.values()) {
    const createdAt = candidate.times.length > 0
      ? Math.min(...candidate.times)
      : undefined;
    const completedAt = candidate.completedTimes.length > 0
      ? Math.max(...candidate.completedTimes)
      : undefined;
    if (candidate.conflict) continue;
    if (!candidate.description || !candidate.completed ||
      createdAt === undefined || completedAt === undefined || completedAt < createdAt) {
      issue(
        "T2O_TRAE_SUBAGENT_RUN_INCOMPLETE",
        candidate.sources[0]?.locator ?? "content.messages",
      );
      continue;
    }
    report.runs.push({
      sourceRunId: candidate.sourceRunId,
      parentRunIds: candidate.parentRunIds!,
      agentId: candidate.agentId!,
      ...(candidate.agentDisplayName ? { agentDisplayName: candidate.agentDisplayName } : {}),
      description: candidate.description,
      ...(candidate.runMode ? { runMode: candidate.runMode } : {}),
      entryIndexes: [...candidate.entryIndexes].sort((left, right) => left - right),
      ...(candidate.responseEntryIndexes.length > 0
        ? { responseEntryIndex: Math.max(...candidate.responseEntryIndexes) }
        : {}),
      createdAt,
      completedAt,
      sources: candidate.sources,
    });
  }
  report.runs.sort((left, right) =>
    left.entryIndexes[0] - right.entryIndexes[0] ||
    left.sourceRunId.localeCompare(right.sourceRunId));
  return report;
}
