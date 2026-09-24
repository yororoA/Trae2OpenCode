import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_DEFINITIONS } from "../../shared/error-codes.js";
import type { DiscoveredTraeRoot } from "./path-discovery.js";
import { assertTraeParserCapability, RUNTIME_PROFILE, VERIFIED_TRAE_PRODUCT_VERSION, WORKSPACE_PROFILE } from "./profile-definitions.js";
import { assertResourcePath, inspectResourceFile } from "./resource-file.js";
import {
  parseTraeReasoningPlan,
  type TraePlanItem,
  type TraeReasoningBlock,
  type TraeReasoningPlanIssueCode,
} from "./reasoning-plan.js";
import { parseTraeToolCalls, type TraeToolCall, type TraeToolIssueCode } from "./tool-calls.js";
import type { TraeQueryCacheEntry } from "./user-messages.js";

export const VERIFIED_TRAE_ASSISTANT_MESSAGE_VERSION = VERIFIED_TRAE_PRODUCT_VERSION;

export type TraeAssistantMessageStatus =
  | "completed"
  | "in-progress"
  | "unknown";

export type TraeAssistantMessageSourceKind =
  | "runtime-assistant-message"
  | "workspace-long-text"
  | "workspace-query-cache-reference"
  | "explicit-long-text-reference";

export type TraeAssistantMessageIssueCode =
  | TraeReasoningPlanIssueCode
  | TraeToolIssueCode
  | "T2O_TRAE_ASSISTANT_MESSAGE_CONTAINER_INVALID"
  | "T2O_TRAE_ASSISTANT_MESSAGE_RECORD_INVALID"
  | "T2O_TRAE_ASSISTANT_MESSAGE_CONTENT_INVALID"
  | "T2O_TRAE_ASSISTANT_MESSAGE_TEXT_MISSING"
  | "T2O_TRAE_ASSISTANT_MESSAGE_STATUS_INVALID"
  | "T2O_TRAE_ASSISTANT_MESSAGE_TIMING_INVALID"
  | "T2O_TRAE_ASSISTANT_MESSAGE_TIMING_ORDER_INVALID"
  | "T2O_TRAE_ASSISTANT_MESSAGE_COMPLETION_TIME_MISSING"
  | "T2O_TRAE_ASSISTANT_MESSAGE_DUPLICATE_CONFLICT"
  | "T2O_TRAE_ASSISTANT_MESSAGE_PROVIDER_FAILED"
  | "T2O_TRAE_LONG_TEXT_SCAN_FAILED"
  | "T2O_TRAE_LONG_TEXT_LAYOUT_INVALID"
  | "T2O_TRAE_LONG_TEXT_READ_FAILED"
  | "T2O_TRAE_LONG_TEXT_REFERENCE_INVALID"
  | "T2O_TRAE_LONG_TEXT_REFERENCE_MISSING"
  | "T2O_TRAE_LONG_TEXT_UNASSOCIATED";

export interface TraeAssistantMessageSource {
  kind: TraeAssistantMessageSourceKind;
  locator: string;
  sha256: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  workspaceStorageId?: string;
}

export interface TraeAssistantTextSource {
  locator: string;
  sha256: string;
}

export interface TraeAssistantText {
  text: string;
  source: TraeAssistantTextSource;
}

export interface TraeAssistantMessage {
  sourceMessageId: string;
  sourceSessionId: string;
  turnId: string;
  replyToMessageId: string;
  messageType: "general" | "task";
  order: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  status: TraeAssistantMessageStatus;
  textBlocks: TraeAssistantText[];
  reasoningBlocks: TraeReasoningBlock[];
  planItems: TraePlanItem[];
  toolCalls: TraeToolCall[];
  sources: TraeAssistantMessageSource[];
}

export interface TraeLongTextReference {
  workspaceStorageId: string;
  path: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
}

export interface TraeLongTextResource {
  resourceId: string;
  workspaceStorageId: string;
  relativePath: string;
  scope: string;
  entryId: string;
  fileName: string;
  sizeBytes: number;
  contentSha256: string;
  sources: TraeAssistantMessageSource[];
  references: TraeAssistantMessageSource[];
}

export interface TraeAssistantMessageIssue {
  code: TraeAssistantMessageIssueCode;
  severity: "warning" | "error";
  message: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  workspaceStorageId?: string;
  entryIndex?: number;
  field?: "content" | "status" | "chat_start_time" | "chat_end_time";
  resourcePathSha256?: string;
  referenceSha256?: string;
  contentLocator?: string;
}

export interface TraeAssistantMessageReport {
  reportVersion: 1;
  productVersion: string;
  messages: TraeAssistantMessage[];
  longTextResources: TraeLongTextResource[];
  sourceCounts: Record<TraeAssistantMessageSourceKind, number>;
  issues: TraeAssistantMessageIssue[];
}

export interface TraeRuntimeAssistantMessageRequest {
  sourceSessionId: string;
}

export type TraeRuntimeAssistantMessageProvider = (
  request: TraeRuntimeAssistantMessageRequest,
) => unknown | Promise<unknown>;

export interface ReadTraeAssistantMessagesOptions {
  root: DiscoveredTraeRoot;
  productVersion: string;
  sourceSessionIds: readonly string[];
  queryCacheEntries?: readonly TraeQueryCacheEntry[];
  longTextReferences?: readonly TraeLongTextReference[];
  runtimeMessageProvider?: TraeRuntimeAssistantMessageProvider;
}

interface AssistantContentResult {
  valid: boolean;
  textBlocks: TraeAssistantText[];
}

interface LongTextResourceCandidate {
  absolutePath: string;
  resource: TraeLongTextResource;
}

interface LongTextReferenceCandidate {
  kind:
    | "workspace-query-cache-reference"
    | "explicit-long-text-reference";
  workspaceStorageId: string;
  path: string;
  locator: string;
  sha256: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const WORKSPACE_STORAGE_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
const QUERY_LONG_TEXT_PATH_FIELDS = new Set([
  "filePath",
  "relatePath",
]);

const ISSUE_MESSAGES: Record<
  Exclude<TraeAssistantMessageIssueCode, TraeReasoningPlanIssueCode | TraeToolIssueCode>,
  string
> = {
  T2O_TRAE_ASSISTANT_MESSAGE_CONTAINER_INVALID:
    "The TRAE runtime message container is invalid.",
  T2O_TRAE_ASSISTANT_MESSAGE_RECORD_INVALID:
    "A TRAE runtime assistant message record is invalid.",
  T2O_TRAE_ASSISTANT_MESSAGE_CONTENT_INVALID:
    "A TRAE runtime assistant content envelope is invalid.",
  T2O_TRAE_ASSISTANT_MESSAGE_TEXT_MISSING:
    "A TRAE assistant message has no mapped text.",
  T2O_TRAE_ASSISTANT_MESSAGE_STATUS_INVALID:
    "A TRAE assistant message status is unsupported.",
  T2O_TRAE_ASSISTANT_MESSAGE_TIMING_INVALID:
    "A TRAE assistant message timing field is invalid.",
  T2O_TRAE_ASSISTANT_MESSAGE_TIMING_ORDER_INVALID:
    "A TRAE assistant message completion time precedes its start time.",
  T2O_TRAE_ASSISTANT_MESSAGE_COMPLETION_TIME_MISSING:
    "A completed TRAE assistant message has no completion time.",
  T2O_TRAE_ASSISTANT_MESSAGE_DUPLICATE_CONFLICT:
    "Conflicting TRAE runtime assistant messages share an identifier.",
  T2O_TRAE_ASSISTANT_MESSAGE_PROVIDER_FAILED:
    ERROR_DEFINITIONS.T2O_TRAE_ASSISTANT_MESSAGE_PROVIDER_FAILED
      .message,
  T2O_TRAE_LONG_TEXT_SCAN_FAILED:
    "A TRAE long-text directory could not be scanned.",
  T2O_TRAE_LONG_TEXT_LAYOUT_INVALID:
    "A TRAE long-text entry has an unsupported layout.",
  T2O_TRAE_LONG_TEXT_READ_FAILED:
    "A TRAE long-text entry could not be read as UTF-8.",
  T2O_TRAE_LONG_TEXT_REFERENCE_INVALID:
    "A TRAE long-text reference is invalid or outside its workspace.",
  T2O_TRAE_LONG_TEXT_REFERENCE_MISSING:
    "A TRAE long-text reference does not resolve to a scanned entry.",
  T2O_TRAE_LONG_TEXT_UNASSOCIATED:
    "A TRAE long-text entry has no explicit source reference.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : `"${value}"`;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalize(item)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function sha256(value: unknown): string {
  return `sha256:${crypto
    .createHash("sha256")
    .update(canonicalize(value))
    .digest("hex")}`;
}

function createIssue(
  code: keyof typeof ISSUE_MESSAGES,
  options: Omit<TraeAssistantMessageIssue, "code" | "message">,
): TraeAssistantMessageIssue {
  return {
    code,
    message: ISSUE_MESSAGES[code],
    ...options,
  };
}

function assertSupportedVersion(productVersion: string): void {
  assertTraeParserCapability(productVersion, RUNTIME_PROFILE, "assistant-messages", "T2O_TRAE_ASSISTANT_MESSAGE_VERSION_UNSUPPORTED");
}

function parseIdentifier(
  value: unknown,
  pattern = IDENTIFIER_PATTERN,
): string | undefined {
  return typeof value === "string" && pattern.test(value)
    ? value
    : undefined;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function parseSecondTimestamp(value: unknown): number | undefined {
  const seconds = parseNonNegativeInteger(value);
  const maximumSeconds = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
  return seconds !== undefined && seconds <= maximumSeconds
    ? seconds * 1_000
    : undefined;
}

function parseMillisecondTimestamp(value: unknown): number | undefined {
  return parseNonNegativeInteger(value);
}

function getRuntimeRecords(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  if (Array.isArray(value.messages)) return value.messages;
  if (Array.isArray(value.items)) return value.items;
  if (!isRecord(value.data)) return null;
  if (Array.isArray(value.data.messages)) return value.data.messages;
  if (Array.isArray(value.data.items)) return value.data.items;
  if (!isRecord(value.data.data)) return null;
  if (Array.isArray(value.data.data.messages)) {
    return value.data.data.messages;
  }
  return Array.isArray(value.data.data.items)
    ? value.data.data.items
    : null;
}

function parseContentRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function createText(
  text: unknown,
  locator: string,
): TraeAssistantText | null {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }
  return {
    text,
    source: {
      locator,
      sha256: sha256(text),
    },
  };
}

function parseGeneralContent(value: unknown): AssistantContentResult {
  const envelope = parseContentRecord(value);
  if (!envelope) return { valid: false, textBlocks: [] };

  const text = createText(envelope.content, "content.content");
  const hasValidTextField =
    envelope.content === undefined ||
    envelope.content === null ||
    typeof envelope.content === "string";
  return {
    valid: hasValidTextField,
    textBlocks: text ? [text] : [],
  };
}

function parseToolSummary(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.tool_call_info)) {
    return undefined;
  }
  const toolCall = value.tool_call_info;
  const isResponseTool =
    toolCall.name === "finish" ||
    toolCall.name === "Finish" ||
    toolCall.name === "response_to_user";
  if (!isResponseTool) return undefined;

  const params = parseContentRecord(toolCall.params);
  return params &&
    typeof params.summary === "string" &&
    params.summary.trim().length > 0
    ? params.summary
    : undefined;
}

function parseChatTaskContent(
  messages: unknown[],
): AssistantContentResult {
  let valid = true;
  const thoughts: Array<{ entryIndex: number; text: TraeAssistantText }> = [];
  let summary: { entryIndex: number; text: TraeAssistantText } | null = null;

  for (const [entryIndex, value] of messages.entries()) {
    if (!isRecord(value)) {
      valid = false;
      continue;
    }
    const isKnownType =
      value.type === "proposal" ||
      value.type === "plan_item" ||
      value.type === "agent_call";
    if (!isKnownType) valid = false;
    if (value.type !== "plan_item") continue;
    if (!isRecord(value.plan_item)) {
      valid = false;
      continue;
    }

    const thought = value.plan_item.thought;
    const hasValidThought =
      thought === undefined ||
      thought === null ||
      typeof thought === "string";
    if (!hasValidThought) valid = false;
    const progressText = createText(
      thought,
      `content.messages[${entryIndex}].plan_item.thought`,
    );
    if (progressText) thoughts.push({ entryIndex, text: progressText });

    const responseSummary = parseToolSummary(value.plan_item);
    if (responseSummary) {
      const text = createText(
        responseSummary,
        `content.messages[${entryIndex}].plan_item.tool_call_info.params.summary`,
      );
      if (text) summary = { entryIndex, text };
    }
  }

  const textBlocks = thoughts
    .filter(({ text }) => text.text !== summary?.text.text)
    .map(({ entryIndex, text }) => ({ entryIndex, rank: 0, text }));
  if (summary) {
    textBlocks.push({ entryIndex: summary.entryIndex, rank: 1, text: summary.text });
  }
  return {
    valid,
    textBlocks: textBlocks
      .sort((left, right) => left.entryIndex - right.entryIndex || left.rank - right.rank)
      .map(({ text }) => text),
  };
}

function parseProposalTaskContent(
  messages: unknown[],
): AssistantContentResult {
  let valid = true;
  const textBlocks: TraeAssistantText[] = [];

  for (const [entryIndex, value] of messages.entries()) {
    if (!isRecord(value)) {
      valid = false;
      continue;
    }
    const isKnownType =
      value.type === "proposal" ||
      value.type === "plan_item" ||
      value.type === "agent_call";
    if (!isKnownType) valid = false;
    if (value.type !== "proposal") continue;
    if (
      !isRecord(value.proposal) ||
      !isRecord(value.proposal.content)
    ) {
      valid = false;
      continue;
    }

    const thought = value.proposal.content.thought;
    const hasValidThought =
      thought === undefined ||
      thought === null ||
      typeof thought === "string";
    if (!hasValidThought) {
      valid = false;
      continue;
    }
    const text = createText(
      thought,
      `content.messages[${entryIndex}].proposal.content.thought`,
    );
    if (text) textBlocks.push(text);
  }
  return { valid, textBlocks };
}

function parseTaskContent(
  value: unknown,
  agentType: unknown,
): AssistantContentResult {
  const envelope = parseContentRecord(value);
  if (!envelope || !Array.isArray(envelope.messages)) {
    return { valid: false, textBlocks: [] };
  }
  const usesPlanSummary =
    agentType === "chat" ||
    agentType === "solo_agent";
  return usesPlanSummary
    ? parseChatTaskContent(envelope.messages)
    : parseProposalTaskContent(envelope.messages);
}

function normalizeStatus(value: unknown): TraeAssistantMessageStatus {
  if (value === "completed") return "completed";
  if (value === "in_progress") return "in-progress";
  return "unknown";
}

function compareSources(
  left: TraeAssistantMessageSource,
  right: TraeAssistantMessageSource,
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    (left.sourceSessionId ?? "").localeCompare(
      right.sourceSessionId ?? "",
    ) ||
    (left.sourceMessageId ?? "").localeCompare(
      right.sourceMessageId ?? "",
    ) ||
    (left.workspaceStorageId ?? "").localeCompare(
      right.workspaceStorageId ?? "",
    ) ||
    left.locator.localeCompare(right.locator) ||
    left.sha256.localeCompare(right.sha256)
  );
}

function deduplicateSources(
  sources: TraeAssistantMessageSource[],
): TraeAssistantMessageSource[] {
  return [
    ...new Map(
      sources.map((source) => [canonicalize(source), source]),
    ).values(),
  ].sort(compareSources);
}

function compareMessages(
  left: TraeAssistantMessage,
  right: TraeAssistantMessage,
): number {
  return (
    left.sourceSessionId.localeCompare(right.sourceSessionId) ||
    left.order - right.order ||
    left.createdAt - right.createdAt ||
    left.sourceMessageId.localeCompare(right.sourceMessageId)
  );
}

function mergeMessages(
  messages: TraeAssistantMessage[],
  issues: TraeAssistantMessageIssue[],
): TraeAssistantMessage[] {
  const accepted = new Map<string, TraeAssistantMessage>();
  const conflicted = new Set<string>();

  for (const message of messages) {
    const sourceMessageId = message.sourceMessageId;
    if (conflicted.has(sourceMessageId)) continue;

    const existing = accepted.get(sourceMessageId);
    if (!existing) {
      accepted.set(sourceMessageId, message);
      continue;
    }

    if (existing.sources[0]?.sha256 === message.sources[0]?.sha256) {
      existing.sources = deduplicateSources([
        ...existing.sources,
        ...message.sources,
      ]);
      continue;
    }

    accepted.delete(sourceMessageId);
    conflicted.add(sourceMessageId);
    issues.push(
      createIssue(
        "T2O_TRAE_ASSISTANT_MESSAGE_DUPLICATE_CONFLICT",
        {
          severity: "error",
          sourceSessionId: existing.sourceSessionId,
          sourceMessageId,
        },
      ),
    );
  }
  return [...accepted.values()].sort(compareMessages);
}

function parseRuntimeRecord(
  value: unknown,
  entryIndex: number,
  issues: TraeAssistantMessageIssue[],
): TraeAssistantMessage | null {
  if (!isRecord(value)) {
    issues.push(
      createIssue("T2O_TRAE_ASSISTANT_MESSAGE_RECORD_INVALID", {
        severity: "error",
        entryIndex,
      }),
    );
    return null;
  }
  if (value.role === "user") return null;
  if (value.role !== "assistant") {
    issues.push(
      createIssue("T2O_TRAE_ASSISTANT_MESSAGE_RECORD_INVALID", {
        severity: "error",
        entryIndex,
      }),
    );
    return null;
  }

  const sourceMessageId = parseIdentifier(value.message_id);
  const sourceSessionId = parseIdentifier(
    value.chat_session_id,
    SESSION_ID_PATTERN,
  );
  const turnId = parseIdentifier(value.turn_id);
  const replyToMessageId = parseIdentifier(value.reply_to_message_id);
  const order = parseNonNegativeInteger(value.message_index);
  const createdAt = parseSecondTimestamp(value.created_at);
  const messageType =
    value.message_type === "general" || value.message_type === "task"
      ? value.message_type
      : undefined;
  const hasInvalidIdentity =
    sourceMessageId === undefined ||
    sourceSessionId === undefined ||
    turnId === undefined ||
    replyToMessageId === undefined ||
    order === undefined ||
    createdAt === undefined ||
    messageType === undefined;
  if (hasInvalidIdentity) {
    issues.push(
      createIssue("T2O_TRAE_ASSISTANT_MESSAGE_RECORD_INVALID", {
        severity: "error",
        entryIndex,
        ...(sourceMessageId ? { sourceMessageId } : {}),
        ...(sourceSessionId ? { sourceSessionId } : {}),
      }),
    );
    return null;
  }

  const status = normalizeStatus(value.status);
  if (status === "unknown") {
    issues.push(
      createIssue("T2O_TRAE_ASSISTANT_MESSAGE_STATUS_INVALID", {
        severity: "warning",
        sourceSessionId,
        sourceMessageId,
        entryIndex,
        field: "status",
      }),
    );
  }

  let startedAt: number | undefined;
  if (
    value.chat_start_time !== undefined &&
    value.chat_start_time !== null &&
    value.chat_start_time !== ""
  ) {
    startedAt = parseMillisecondTimestamp(value.chat_start_time);
    if (startedAt === undefined) {
      issues.push(
        createIssue("T2O_TRAE_ASSISTANT_MESSAGE_TIMING_INVALID", {
          severity: "error",
          sourceSessionId,
          sourceMessageId,
          entryIndex,
          field: "chat_start_time",
        }),
      );
    }
  }

  let completedAt: number | undefined;
  if (
    value.chat_end_time !== undefined &&
    value.chat_end_time !== null &&
    value.chat_end_time !== ""
  ) {
    completedAt = parseMillisecondTimestamp(value.chat_end_time);
    if (completedAt === undefined) {
      issues.push(
        createIssue("T2O_TRAE_ASSISTANT_MESSAGE_TIMING_INVALID", {
          severity: "error",
          sourceSessionId,
          sourceMessageId,
          entryIndex,
          field: "chat_end_time",
        }),
      );
    }
  }
  if (
    startedAt !== undefined &&
    completedAt !== undefined &&
    completedAt < startedAt
  ) {
    issues.push(
      createIssue(
        "T2O_TRAE_ASSISTANT_MESSAGE_TIMING_ORDER_INVALID",
        {
          severity: "error",
          sourceSessionId,
          sourceMessageId,
          entryIndex,
        },
      ),
    );
    completedAt = undefined;
  }
  if (status === "completed" && completedAt === undefined) {
    issues.push(
      createIssue(
        "T2O_TRAE_ASSISTANT_MESSAGE_COMPLETION_TIME_MISSING",
        {
          severity: "warning",
          sourceSessionId,
          sourceMessageId,
          entryIndex,
          field: "chat_end_time",
        },
      ),
    );
  }

  const content =
    messageType === "general"
      ? parseGeneralContent(value.content)
      : parseTaskContent(value.content, value.agent_type);
  if (!content.valid) {
    issues.push(
      createIssue("T2O_TRAE_ASSISTANT_MESSAGE_CONTENT_INVALID", {
        severity: "error",
        sourceSessionId,
        sourceMessageId,
        entryIndex,
        field: "content",
      }),
    );
  }
  if (content.textBlocks.length === 0) {
    issues.push(
      createIssue("T2O_TRAE_ASSISTANT_MESSAGE_TEXT_MISSING", {
        severity: "warning",
        sourceSessionId,
        sourceMessageId,
        entryIndex,
        field: "content",
      }),
    );
  }

  const reasoningPlan = parseTraeReasoningPlan(
    value.content,
    messageType,
    VERIFIED_TRAE_ASSISTANT_MESSAGE_VERSION,
    content.textBlocks.map((block) => block.source.locator),
  );
  issues.push(...reasoningPlan.issues.map((issue) => ({
    ...issue,
    sourceSessionId,
    sourceMessageId,
    entryIndex,
  })));
  const tools = parseTraeToolCalls(value.content, messageType, VERIFIED_TRAE_ASSISTANT_MESSAGE_VERSION);
  issues.push(...tools.issues.map((issue) => ({ ...issue, sourceSessionId, sourceMessageId, entryIndex })));

  return {
    sourceMessageId,
    sourceSessionId,
    turnId,
    replyToMessageId,
    messageType,
    order,
    createdAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    status,
    textBlocks: content.textBlocks,
    reasoningBlocks: reasoningPlan.reasoningBlocks,
    planItems: reasoningPlan.planItems,
    toolCalls: tools.toolCalls,
    sources: [
      {
        kind: "runtime-assistant-message",
        locator: "runtime:getMessages#message",
        sourceSessionId,
        sourceMessageId,
        sha256: sha256(value),
      },
    ],
  };
}

export function parseTraeRuntimeAssistantMessages(
  value: unknown,
  productVersion: string,
): Pick<TraeAssistantMessageReport, "messages" | "issues"> {
  assertSupportedVersion(productVersion);
  const records = getRuntimeRecords(value);
  if (!records) {
    return {
      messages: [],
      issues: [
        createIssue(
          "T2O_TRAE_ASSISTANT_MESSAGE_CONTAINER_INVALID",
          { severity: "error" },
        ),
      ],
    };
  }

  const issues: TraeAssistantMessageIssue[] = [];
  const messages = records.flatMap((record, entryIndex) => {
    const parsed = parseRuntimeRecord(record, entryIndex, issues);
    return parsed ? [parsed] : [];
  });
  return {
    messages: mergeMessages(messages, issues),
    issues,
  };
}

function resourcePathSha256(relativePath: string): string {
  return sha256({ relativePath });
}

function walkLongTextDirectory(
  directoryPath: string,
  longTextRoot: string,
  workspaceStorageId: string,
  resources: LongTextResourceCandidate[],
  issues: TraeAssistantMessageIssue[],
): void {
  let entries: fs.Dirent[];
  try {
    assertResourcePath(path.dirname(path.dirname(longTextRoot)), directoryPath);
    entries = fs
      .readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    issues.push(
      createIssue("T2O_TRAE_LONG_TEXT_SCAN_FAILED", {
        severity: "error",
        workspaceStorageId,
      }),
    );
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    const relativePath = path.relative(longTextRoot, absolutePath);
    const relativePathHash = resourcePathSha256(relativePath);
    if (entry.isSymbolicLink()) {
      issues.push(
        createIssue("T2O_TRAE_LONG_TEXT_LAYOUT_INVALID", {
          severity: "error",
          workspaceStorageId,
          resourcePathSha256: relativePathHash,
        }),
      );
      continue;
    }
    if (entry.isDirectory() && relativePath.split(path.sep).length < 3) {
      walkLongTextDirectory(
        absolutePath,
        longTextRoot,
        workspaceStorageId,
        resources,
        issues,
      );
      continue;
    }

    const segments = relativePath.split(path.sep);
    const hasSupportedLayout =
      entry.isFile() &&
      segments.length === 3 &&
      path.extname(entry.name) === ".txt";
    if (!hasSupportedLayout) {
      issues.push(
        createIssue("T2O_TRAE_LONG_TEXT_LAYOUT_INVALID", {
          severity: "error",
          workspaceStorageId,
          resourcePathSha256: relativePathHash,
        }),
      );
      continue;
    }

    let metadata: ReturnType<typeof inspectResourceFile>;
    try {
      metadata = inspectResourceFile(
        path.dirname(path.dirname(longTextRoot)),
        absolutePath,
        true,
      );
    } catch {
      issues.push(
        createIssue("T2O_TRAE_LONG_TEXT_READ_FAILED", {
          severity: "error",
          workspaceStorageId,
          resourcePathSha256: relativePathHash,
        }),
      );
      continue;
    }

    const contentSha256 = metadata.sha256;
    const [scope, entryId, fileName] = segments as [
      string,
      string,
      string,
    ];
    resources.push({
      absolutePath: path.resolve(absolutePath),
      resource: {
        resourceId: sha256({ workspaceStorageId, relativePath }),
        workspaceStorageId,
        relativePath,
        scope,
        entryId,
        fileName,
        sizeBytes: metadata.sizeBytes,
        contentSha256,
        sources: [
          {
            kind: "workspace-long-text",
            locator: `long-text/${relativePath}`,
            workspaceStorageId,
            sha256: contentSha256,
          },
        ],
        references: [],
      },
    });
  }
}

function scanLongTextCandidates(
  root: DiscoveredTraeRoot,
  issues: TraeAssistantMessageIssue[],
): LongTextResourceCandidate[] {
  if (!root.availability.workspaceStorage) return [];

  let workspaceEntries: fs.Dirent[];
  try {
    workspaceEntries = fs.readdirSync(root.workspaceStoragePath, {
      withFileTypes: true,
    });
  } catch {
    issues.push(
      createIssue("T2O_TRAE_LONG_TEXT_SCAN_FAILED", {
        severity: "error",
      }),
    );
    return [];
  }

  const resources: LongTextResourceCandidate[] = [];
  for (const workspaceEntry of workspaceEntries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const workspaceStorageId = workspaceEntry.name;
    const longTextRoot = path.join(
      root.workspaceStoragePath,
      workspaceStorageId,
      "long-text",
    );
    let isDirectory = false;
    try {
      const stat = fs.lstatSync(longTextRoot);
      if (stat.isSymbolicLink()) {
        issues.push(createIssue("T2O_TRAE_LONG_TEXT_LAYOUT_INVALID", {
          severity: "error",
          workspaceStorageId,
        }));
        continue;
      }
      isDirectory = stat.isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;
    walkLongTextDirectory(
      longTextRoot,
      longTextRoot,
      workspaceStorageId,
      resources,
      issues,
    );
  }
  return resources;
}

function collectPathFields(
  value: unknown,
  locator: string,
  visit: (pathValue: unknown, locator: string) => void,
): void {
  if (Array.isArray(value)) {
    for (const [entryIndex, item] of value.entries()) {
      collectPathFields(
        item,
        `${locator}[${entryIndex}]`,
        visit,
      );
    }
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, item] of Object.entries(value)) {
    const fieldLocator = `${locator}.${key}`;
    if (QUERY_LONG_TEXT_PATH_FIELDS.has(key)) {
      visit(item, fieldLocator);
    }
    collectPathFields(item, fieldLocator, visit);
  }
}

function isPotentialLongTextQueryPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /(?:^|[\\/])long-text(?:[\\/]|$)/.test(value)
  );
}

function collectQueryCacheReferences(
  entries: readonly TraeQueryCacheEntry[],
): LongTextReferenceCandidate[] {
  const references: LongTextReferenceCandidate[] = [];
  for (const entry of entries) {
    for (const source of entry.sources) {
      const workspaceStorageId = source.workspaceStorageId;
      if (!workspaceStorageId) continue;
      collectPathFields(
        entry.parsedQuery,
        "parsedQuery",
        (pathValue, locator) => {
          if (!isPotentialLongTextQueryPath(pathValue)) return;
          references.push({
            kind: "workspace-query-cache-reference",
            workspaceStorageId,
            path: pathValue,
            locator: `query-cache:${entry.sha256}#${locator}`,
            sha256: source.sha256,
          });
        },
      );
    }
  }
  return references;
}

function collectExplicitReferences(
  references: readonly TraeLongTextReference[],
  issues: TraeAssistantMessageIssue[],
): LongTextReferenceCandidate[] {
  return references.flatMap((reference, entryIndex) => {
    const workspaceStorageId = parseIdentifier(
      reference.workspaceStorageId,
      WORKSPACE_STORAGE_ID_PATTERN,
    );
    const sourceSessionId =
      reference.sourceSessionId === undefined
        ? undefined
        : parseIdentifier(
            reference.sourceSessionId,
            SESSION_ID_PATTERN,
          );
    const sourceMessageId =
      reference.sourceMessageId === undefined
        ? undefined
        : parseIdentifier(reference.sourceMessageId);
    const hasInvalidReference =
      workspaceStorageId === undefined ||
      typeof reference.path !== "string" ||
      reference.path.length === 0 ||
      (reference.sourceSessionId !== undefined &&
        sourceSessionId === undefined) ||
      (reference.sourceMessageId !== undefined &&
        sourceMessageId === undefined);
    if (hasInvalidReference) {
      issues.push(
        createIssue("T2O_TRAE_LONG_TEXT_REFERENCE_INVALID", {
          severity: "error",
          entryIndex,
          referenceSha256: sha256({
            entryIndex,
            workspaceStorageId: reference.workspaceStorageId,
          }),
        }),
      );
      return [];
    }

    return [
      {
        kind: "explicit-long-text-reference" as const,
        workspaceStorageId,
        path: reference.path,
        locator: `explicit-reference[${entryIndex}]`,
        sha256: sha256(reference),
        ...(sourceSessionId ? { sourceSessionId } : {}),
        ...(sourceMessageId ? { sourceMessageId } : {}),
      },
    ];
  });
}

function normalizeReferencePath(
  root: DiscoveredTraeRoot,
  reference: LongTextReferenceCandidate,
): string | null {
  const workspacePath = path.resolve(
    root.workspaceStoragePath,
    reference.workspaceStorageId,
  );
  const workspaceRelative = path.relative(
    path.resolve(root.workspaceStoragePath),
    workspacePath,
  );
  const isDirectWorkspace =
    workspaceRelative.length > 0 &&
    !workspaceRelative.startsWith(`..${path.sep}`) &&
    workspaceRelative !== ".." &&
    !path.isAbsolute(workspaceRelative) &&
    !workspaceRelative.includes(path.sep);
  if (!isDirectWorkspace) return null;

  const longTextRoot = path.join(workspacePath, "long-text");
  let referencedPath = reference.path;
  if (referencedPath.startsWith("file:")) {
    try {
      referencedPath = fileURLToPath(referencedPath);
    } catch {
      return null;
    }
  }

  let absolutePath: string;
  if (path.isAbsolute(referencedPath)) {
    absolutePath = path.resolve(referencedPath);
  } else {
    const normalizedRelative = path.normalize(referencedPath);
    absolutePath =
      normalizedRelative === "long-text" ||
      normalizedRelative.startsWith(`long-text${path.sep}`)
        ? path.resolve(workspacePath, normalizedRelative)
        : path.resolve(longTextRoot, normalizedRelative);
  }

  const relativePath = path.relative(longTextRoot, absolutePath);
  const segments = relativePath.split(path.sep);
  const isInsideLongText =
    relativePath.length > 0 &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== ".." &&
    !path.isAbsolute(relativePath);
  const hasSupportedLayout =
    segments.length === 3 &&
    path.extname(segments[2] ?? "") === ".txt";
  return isInsideLongText && hasSupportedLayout
    ? absolutePath
    : null;
}

function associateLongTextReferences(
  root: DiscoveredTraeRoot,
  resources: LongTextResourceCandidate[],
  references: LongTextReferenceCandidate[],
  issues: TraeAssistantMessageIssue[],
): void {
  const byPath = new Map(
    resources.map((candidate) => [
      `${candidate.resource.workspaceStorageId}\0${candidate.absolutePath}`,
      candidate.resource,
    ]),
  );

  for (const reference of references) {
    const absolutePath = normalizeReferencePath(root, reference);
    const referenceSha256 = sha256({
      kind: reference.kind,
      locator: reference.locator,
      sha256: reference.sha256,
    });
    if (!absolutePath) {
      issues.push(
        createIssue("T2O_TRAE_LONG_TEXT_REFERENCE_INVALID", {
          severity: "error",
          workspaceStorageId: reference.workspaceStorageId,
          referenceSha256,
        }),
      );
      continue;
    }

    const resource = byPath.get(
      `${reference.workspaceStorageId}\0${absolutePath}`,
    );
    if (!resource) {
      issues.push(
        createIssue("T2O_TRAE_LONG_TEXT_REFERENCE_MISSING", {
          severity: "warning",
          workspaceStorageId: reference.workspaceStorageId,
          referenceSha256,
        }),
      );
      continue;
    }
    resource.references.push({
      kind: reference.kind,
      locator: reference.locator,
      workspaceStorageId: reference.workspaceStorageId,
      sha256: reference.sha256,
      ...(reference.sourceSessionId
        ? { sourceSessionId: reference.sourceSessionId }
        : {}),
      ...(reference.sourceMessageId
        ? { sourceMessageId: reference.sourceMessageId }
        : {}),
    });
  }

  for (const { resource } of resources) {
    resource.references = deduplicateSources(resource.references);
    if (resource.references.length === 0) {
      issues.push(
        createIssue("T2O_TRAE_LONG_TEXT_UNASSOCIATED", {
          severity: "warning",
          workspaceStorageId: resource.workspaceStorageId,
          resourcePathSha256: resourcePathSha256(
            resource.relativePath,
          ),
        }),
      );
    }
  }
}

function compareLongTextResources(
  left: TraeLongTextResource,
  right: TraeLongTextResource,
): number {
  return (
    left.workspaceStorageId.localeCompare(
      right.workspaceStorageId,
    ) || left.relativePath.localeCompare(right.relativePath)
  );
}

export function scanTraeLongTextResources(
  root: DiscoveredTraeRoot,
  productVersion: string,
  queryCacheEntries: readonly TraeQueryCacheEntry[] = [],
  explicitReferences: readonly TraeLongTextReference[] = [],
): Pick<TraeAssistantMessageReport, "longTextResources" | "issues"> {
  assertTraeParserCapability(productVersion, WORKSPACE_PROFILE, "resources", "T2O_TRAE_ASSISTANT_MESSAGE_VERSION_UNSUPPORTED");
  const issues: TraeAssistantMessageIssue[] = [];
  const resources = scanLongTextCandidates(root, issues);
  const references = [
    ...collectQueryCacheReferences(queryCacheEntries),
    ...collectExplicitReferences(explicitReferences, issues),
  ];
  associateLongTextReferences(root, resources, references, issues);
  return {
    longTextResources: resources
      .map((candidate) => candidate.resource)
      .sort(compareLongTextResources),
    issues,
  };
}

function sourceCounts(
  messages: TraeAssistantMessage[],
  resources: TraeLongTextResource[],
): Record<TraeAssistantMessageSourceKind, number> {
  return {
    "runtime-assistant-message": messages.reduce(
      (count, message) => count + message.sources.length,
      0,
    ),
    "workspace-long-text": resources.reduce(
      (count, resource) => count + resource.sources.length,
      0,
    ),
    "workspace-query-cache-reference": resources.reduce(
      (count, resource) =>
        count +
        resource.references.filter(
          (reference) =>
            reference.kind ===
            "workspace-query-cache-reference",
        ).length,
      0,
    ),
    "explicit-long-text-reference": resources.reduce(
      (count, resource) =>
        count +
        resource.references.filter(
          (reference) =>
            reference.kind === "explicit-long-text-reference",
        ).length,
      0,
    ),
  };
}

export async function readTraeAssistantMessages(
  options: ReadTraeAssistantMessagesOptions,
): Promise<TraeAssistantMessageReport> {
  assertSupportedVersion(options.productVersion);
  const issues: TraeAssistantMessageIssue[] = [];
  const messages: TraeAssistantMessage[] = [];
  const sourceSessionIds = [
    ...new Set(
      options.sourceSessionIds.filter((sourceSessionId) => {
        const valid = SESSION_ID_PATTERN.test(sourceSessionId);
        if (!valid) {
          issues.push(
            createIssue(
              "T2O_TRAE_ASSISTANT_MESSAGE_RECORD_INVALID",
              { severity: "error" },
            ),
          );
        }
        return valid;
      }),
    ),
  ].sort();

  if (options.runtimeMessageProvider) {
    for (const sourceSessionId of sourceSessionIds) {
      try {
        const value = await options.runtimeMessageProvider({
          sourceSessionId,
        });
        const parsed = parseTraeRuntimeAssistantMessages(
          value,
          options.productVersion,
        );
        messages.push(
          ...parsed.messages.filter((message) => {
            if (message.sourceSessionId === sourceSessionId) {
              return true;
            }
            issues.push(
              createIssue(
                "T2O_TRAE_ASSISTANT_MESSAGE_RECORD_INVALID",
                {
                  severity: "error",
                  sourceSessionId: message.sourceSessionId,
                  sourceMessageId: message.sourceMessageId,
                },
              ),
            );
            return false;
          }),
        );
        issues.push(...parsed.issues);
      } catch {
        issues.push(
          createIssue(
            "T2O_TRAE_ASSISTANT_MESSAGE_PROVIDER_FAILED",
            {
              severity: "error",
              sourceSessionId,
            },
          ),
        );
      }
    }
  }

  const longText = scanTraeLongTextResources(
    options.root,
    options.productVersion,
    options.queryCacheEntries,
    options.longTextReferences,
  );
  issues.push(...longText.issues);
  const mergedMessages = mergeMessages(messages, issues);
  return {
    reportVersion: 1,
    productVersion: options.productVersion,
    messages: mergedMessages,
    longTextResources: longText.longTextResources,
    sourceCounts: sourceCounts(
      mergedMessages,
      longText.longTextResources,
    ),
    issues,
  };
}
