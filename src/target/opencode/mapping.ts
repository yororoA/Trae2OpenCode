import { canonicalizeJson, hashCanonicalJson } from "../../ir/canonical.js";
import { validateMigrationBundleIntegrity } from "../../ir/integrity.js";
import type {
  AssistantContentIR, Diagnostic, EventIR, JsonObject, JsonValue,
  MigrationBundle, SessionIR, SourceRef,
} from "../../ir/types.js";
import { assertMigrationBundle } from "../../ir/validation.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import { jsonByteLength, jsonChunks } from "../../shared/json-stream.js";
import {
  assertTraeParserCapability, RUNTIME_PROFILE,
} from "../../source/trae/profile-definitions.js";
import { assertOpenCodeTransfer, isRecord } from "./contract.js";

/** A session payload as a target persists it. Each dialect validates its own fields. */
export interface OpenCodeSession {
  info: JsonObject;
  messages: JsonObject[];
}

/** The v2 transfer: exactly what `SessionTransfer.Data` guarantees. */
export interface OpenCodeTransfer extends OpenCodeSession {
  info: JsonObject & {
    id: string;
    time: { created: number; updated: number };
    location: { directory: string };
  };
}

export interface OpenCodeMappingOptions {
  sessionId: string;
  messageIds: ReadonlyMap<string, string>;
  parentId?: string;
  directory: string;
}

export interface OpenCodeMapping {
  transfer: OpenCodeTransfer;
  diagnostics: Diagnostic[];
}

export const MISSING_TOOL_OUTPUT_TEXT =
  "[TRAE tool completed without persisted output]";
export const MISSING_TOOL_ERROR_TEXT =
  "[TRAE tool failed without a persisted error message]";
export const MISSING_ASSISTANT_TEXT =
  "[TRAE assistant response ended before final text was persisted]";
export const MAX_CONTINUATION_CONTEXT_BYTES = 192 * 1024;
export const MAX_CONTINUATION_RECENT_BYTES = 16 * 1024;

const PARTIAL_PROJECTION_CODES = new Set([
  "T2O_IR_REPLY_REFERENCE_INVALID",
  "T2O_TRAE_TOOL_CALL_INVALID",
  "T2O_TRAE_TOOL_ERROR_UNVERIFIED",
  "T2O_TRAE_USER_MESSAGE_TEXT_MISSING",
]);

function diagnostic(session: SessionIR, code: string, message: string, field?: string): Diagnostic {
  return {
    id: hashCanonicalJson({ session: session.sourceId, code, field: field ?? null }),
    code, message, severity: "warning",
    subject: { type: "session", sourceId: session.sourceId },
    sourceRefs: [],
    ...(field ? { context: { field } } : {}),
  };
}

function reject(session: SessionIR, field: string): never {
  const issue = diagnostic(session, "T2O_OPENCODE_MAPPING_REJECTED",
    "A source field cannot be imported without loss or an unverified interpretation.", field);
  issue.severity = "error";
  throw new Trae2OpenCodeError("T2O_OPENCODE_MAPPING_REJECTED", { diagnostics: [issue] });
}

function hasVerifiedRuntimeRefs(refs: SourceRef[], sourceSessionId: string): boolean {
  return refs.length > 0 && refs.every((ref) =>
    ref.sourceSessionId === sourceSessionId &&
    ref.parserProfile.id === RUNTIME_PROFILE.id &&
    ref.parserProfile.version === RUNTIME_PROFILE.version &&
    ref.locator.type === "runtime-field" &&
    ref.locator.value.startsWith("runtime:getMessages#"));
}

/** Diagnostic ownership is conservative when the parser could not identify a subject. */
function concernsSession(issue: Diagnostic, session: SessionIR): boolean {
  const subject = issue.subject;
  if (!subject || subject.type === "bundle") return true;
  if (issue.sourceRefs.some((ref) => ref.sourceSessionId === session.sourceId)) return true;
  switch (subject.type) {
    case "session": return subject.sourceId === session.sourceId;
    case "project": return subject.sourceId === session.projectSourceId;
    case "event": return session.events.some((event) => event.sourceId === subject.sourceId);
    case "resource": return session.resources.some((resource) => resource.sourceId === subject.sourceId);
  }
}

function concernsEvent(issue: Diagnostic, event: EventIR): boolean {
  return (issue.subject?.type === "event" && issue.subject.sourceId === event.sourceId) ||
    issue.context?.sourceMessageId === event.sourceId;
}

function hasErrorPayload(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return false;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

function encodedToolValue(value: JsonValue): {
  text: string;
  encoding: "text" | "canonical-json";
  sha256: string;
} {
  const isText = typeof value === "string";
  return {
    text: isText ? value : canonicalizeJson(value),
    encoding: isText ? "text" : "canonical-json",
    sha256: hashCanonicalJson(value),
  };
}

type ToolPresentation = {
  name: string;
  input: JsonObject;
  output?: JsonValue;
  metadata: JsonObject;
};

function projectToolPresentation(block: Extract<AssistantContentIR, { type: "tool" }>): ToolPresentation {
  const sourceInput = block.input as JsonObject;
  if (block.name !== "exec_command" || typeof sourceInput.cmd !== "string") {
    return {
      name: block.name,
      input: sourceInput,
      ...(block.output === undefined ? {} : { output: block.output }),
      metadata: {},
    };
  }

  const { cmd, command: sourceCommand, ...inputFields } = sourceInput;
  const input: JsonObject = { ...inputFields, command: cmd };
  const metadata: JsonObject = {
    sourceToolName: block.name,
    sourceCommandField: "cmd",
    ...(sourceCommand === undefined ? {} : { sourceInputCommand: sourceCommand }),
  };
  const sourceOutput = block.output;
  if (!isRecord(sourceOutput)) {
    return {
      name: "shell",
      input,
      ...(sourceOutput === undefined ? {} : { output: sourceOutput }),
      metadata,
    };
  }

  const visibleOutputField = typeof sourceOutput.stdout === "string"
    ? "stdout"
    : typeof sourceOutput.output === "string"
      ? "output"
      : undefined;
  if (!visibleOutputField) {
    return { name: "shell", input, output: sourceOutput, metadata };
  }
  const visibleOutput = sourceOutput[visibleOutputField] as string;
  const mirroredOutputFields = ["stdout", "output"].filter((field) =>
    sourceOutput[field] === visibleOutput);
  const sourceOutputRemainder = Object.fromEntries(
    Object.entries(sourceOutput).filter(([field]) => !mirroredOutputFields.includes(field)),
  ) as JsonObject;
  return {
    name: "shell",
    input,
    output: visibleOutput,
    metadata: {
      ...metadata,
      visibleOutputField,
      mirroredOutputFields,
      sourceOutputRemainder,
      sourceOutputSha256: hashCanonicalJson(sourceOutput),
    },
  };
}

function isTaskProgressText(block: AssistantContentIR): boolean {
  return block.type === "text" && block.sourceRefs.some((ref) =>
    ref.locator.type === "runtime-field" &&
    ref.locator.value.endsWith(".plan_item.thought"));
}

function mapContent(
  block: AssistantContentIR,
  session: SessionIR,
  field: string,
  diagnostics: Diagnostic[],
): JsonObject | undefined {
  if (!hasVerifiedRuntimeRefs(block.sourceRefs, session.sourceId)) reject(session, `${field}.sourceRefs`);
  const time = block.createdAt === undefined ? undefined : {
    created: block.createdAt,
    ...(block.completedAt === undefined ? {} : { completed: block.completedAt }),
  };
  if (block.type === "text") {
    return isTaskProgressText(block)
      ? { type: "reasoning", text: block.text, ...(time ? { time } : {}) }
      : { type: "text", text: block.text };
  }
  if (block.type === "reasoning") {
    return { type: "reasoning", text: block.text, ...(time ? { time } : {}) };
  }
  if (!time) {
    if (session.recovery !== "partial") reject(session, `${field}.createdAt`);
    diagnostics.push(diagnostic(
      session,
      "T2O_OPENCODE_TOOL_TIMING_MISSING",
      "A TRAE tool without a persisted start time is retained in message metadata and omitted from visible content.",
      `${field}.createdAt`,
    ));
    return undefined;
  }
  if (block.status === "streaming") {
    if (typeof block.input !== "string" || block.output !== undefined) reject(session, `${field}.input/output`);
    return {
      type: "tool", id: block.callId, name: block.name, time,
      state: { status: "streaming", input: block.input },
    };
  }
  if (!isRecord(block.input)) reject(session, `${field}.input`);
  const presentation = projectToolPresentation(block);
  if (block.status === "running" || block.status === "unknown") {
    const hasPreservedPayload = block.output !== undefined || hasErrorPayload(block.error);
    const outputProjectedToShell = presentation.name === "shell" &&
      typeof presentation.metadata.visibleOutputField === "string";
    const metadata: JsonObject = block.status === "unknown" || hasPreservedPayload
      ? { trae2opencode: {
        sourceStatus: block.status,
        ...(block.output === undefined || outputProjectedToShell ? {} : { sourceOutput: block.output }),
        ...(hasErrorPayload(block.error) ? { sourceError: block.error as JsonValue } : {}),
        ...presentation.metadata,
      } }
      : Object.keys(presentation.metadata).length > 0
        ? { trae2opencode: presentation.metadata }
        : {};
    if (presentation.name === "shell" && typeof presentation.output === "string") {
      metadata.output = presentation.output;
    }
    if (block.status === "unknown") {
      diagnostics.push(diagnostic(
        session,
        "T2O_OPENCODE_TOOL_STATUS_PROJECTED",
        "An unknown TRAE tool status is represented as running while its source status and payload remain in metadata.",
        `${field}.status`,
      ));
    } else if (hasPreservedPayload) {
      diagnostics.push(diagnostic(
        session,
        "T2O_OPENCODE_RUNNING_TOOL_PAYLOAD_PRESERVED",
        "A running TRAE tool contained a payload; it remains in metadata without changing the source status.",
        `${field}.output/error`,
      ));
    }
    return {
      type: "tool", id: block.callId, name: presentation.name, time,
      state: { status: "running", input: presentation.input, metadata },
    };
  }
  if (block.status === "error") {
    const sourceErrorMissing = !hasErrorPayload(block.error);
    const error = encodedToolValue(sourceErrorMissing
      ? MISSING_TOOL_ERROR_TEXT
      : block.error as JsonValue);
    const output = presentation.output === undefined ? undefined : encodedToolValue(presentation.output);
    diagnostics.push(diagnostic(
      session,
      "T2O_OPENCODE_TOOL_ERROR_PRESERVED",
      "A failed TRAE tool and its persisted payload are represented with the native OpenCode error state.",
      `${field}.status`,
    ));
    return {
      type: "tool", id: block.callId, name: presentation.name, time,
      state: {
        status: "error",
        input: presentation.input,
        error: { type: "TRAE_TOOL_ERROR", message: error.text },
        ...(output ? { content: [{ type: "text", text: output.text }] } : {}),
        metadata: { trae2opencode: {
          ...presentation.metadata,
          errorEncoding: error.encoding,
          errorSha256: error.sha256,
          ...(sourceErrorMissing ? { sourceErrorMissing: true } : {}),
          ...(output ? {
            outputEncoding: output.encoding,
            outputSha256: output.sha256,
          } : {}),
        } },
      },
    };
  }
  if (hasErrorPayload(block.error)) reject(session, `${field}.error`);
  const sourceOutputMissing = presentation.output === undefined;
  const outputValue: JsonValue = sourceOutputMissing
    ? MISSING_TOOL_OUTPUT_TEXT
    : presentation.output as JsonValue;
  const output = encodedToolValue(outputValue);
  if (sourceOutputMissing) {
    diagnostics.push(diagnostic(
      session,
      "T2O_OPENCODE_TOOL_OUTPUT_MISSING",
      "TRAE marked a tool completed without persisting output; the target contains an explicit placeholder.",
      `${field}.output`,
    ));
  }
  if (block.completedAt === undefined) {
    diagnostics.push(diagnostic(
      session,
      "T2O_OPENCODE_TOOL_COMPLETION_TIME_MISSING",
      "TRAE marked a tool completed without persisting its completion time; no timestamp was synthesized.",
      `${field}.completedAt`,
    ));
  }
  return {
    type: "tool", id: block.callId, name: presentation.name, time,
    state: {
      status: "completed", input: presentation.input,
      content: [{ type: "text", text: output.text }],
      metadata: { trae2opencode: {
        ...presentation.metadata,
        outputEncoding: output.encoding,
        outputSha256: output.sha256,
        ...(sourceOutputMissing ? { sourceOutputMissing: true } : {}),
      } },
    },
  };
}

function hasValidReply(session: SessionIR, event: EventIR): boolean {
  if (event.type !== "assistant" || !event.replyToSourceId) return false;
  const reply = session.events.find((candidate) => candidate.sourceId === event.replyToSourceId);
  return reply?.type === "user" && reply.order < event.order;
}

function eventMetadata(event: EventIR, validReply: boolean): JsonObject {
  const deferredContent = event.type === "assistant"
    ? event.content.flatMap((block, sourceIndex) =>
      block.type === "tool" && block.createdAt === undefined
        ? [{ sourceIndex, block: block as unknown as JsonValue }]
        : [])
    : [];
  return {
    sourceId: event.sourceId, order: event.order,
    ...(event.turnSourceId ? { turnSourceId: event.turnSourceId } : {}),
    ...(validReply && event.replyToSourceId ? { replyToSourceId: event.replyToSourceId } : {}),
    ...(!validReply && event.type === "assistant" ? {
      replyReferenceStatus: event.replyToSourceId ? "unresolved" : "missing",
      ...(event.replyToSourceId ? { unresolvedReplyToSourceId: event.replyToSourceId } : {}),
    } : {}),
    ...(event.type === "assistant" ? {
      status: event.status,
      unknownSourceFields: ["agent", "model"],
      // Text has no native time field; the parallel metadata preserves every block's time.
      content: event.content.map((block) => ({
        ...(block.createdAt === undefined ? {} : { createdAt: block.createdAt }),
        ...(block.completedAt === undefined ? {} : { completedAt: block.completedAt }),
      })),
      ...(deferredContent.length > 0 ? { deferredContent } : {}),
    } : {}),
  };
}

const CONTEXT_CANONICAL_OPTIONS = {
  pretty: true,
  sortKeys: true,
  trailingNewline: true,
} as const;

function jsonPrefix(value: JsonValue, limit: number): string {
  let result = "";
  for (const chunk of jsonChunks(value, CONTEXT_CANONICAL_OPTIONS)) {
    result += chunk.slice(0, limit - result.length);
    if (result.length === limit) break;
  }
  return result;
}

function contextBytes(message: JsonObject): number {
  if (message.type === "user") {
    return Buffer.byteLength(typeof message.text === "string" ? message.text : "", "utf8") + 32;
  }
  if (message.type !== "assistant" || !Array.isArray(message.content)) return 0;
  return message.content.reduce<number>((total, block) => {
    if (!isRecord(block)) return total;
    if ((block.type === "text" || block.type === "reasoning") && typeof block.text === "string") {
      return total + Buffer.byteLength(block.text, "utf8") + 32;
    }
    if (block.type !== "tool") return total;
    const state = isRecord(block.state) ? block.state : {};
    const content = Array.isArray(state.content)
      ? state.content.reduce<string>((text, item) => {
        if (text.length >= 2_000 || !isRecord(item) || typeof item.text !== "string") return text;
        const separator = text ? "\n" : "";
        return `${text}${separator}${item.text.slice(0, 2_000 - text.length - separator.length)}`;
      }, "")
      : "";
    const inputBytes = jsonByteLength((state.input ?? null) as JsonValue, CONTEXT_CANONICAL_OPTIONS);
    const error = state.error === undefined ? "" : jsonPrefix(state.error as JsonValue, 2_000);
    return total + inputBytes +
      Buffer.byteLength(content, "utf8") +
      Buffer.byteLength(error, "utf8") + 64;
  }, 0);
}

function tailUtf8(value: string, limit: number): string {
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    let characterStart = start - 1;
    const last = value.charCodeAt(characterStart);
    if (last >= 0xdc00 && last <= 0xdfff && characterStart > 0) {
      const previous = value.charCodeAt(characterStart - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) characterStart--;
    }
    const character = value.slice(characterStart, start);
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    bytes += size;
    start = characterStart;
  }
  return value.slice(start);
}

function recentEntry(role: "User" | "Assistant", text: string): string {
  const prefix = `[${role}]: `;
  return `${prefix}${tailUtf8(
    text,
    MAX_CONTINUATION_RECENT_BYTES - Buffer.byteLength(prefix, "utf8"),
  )}`;
}

function updateRecentContext(previous: string, message: JsonObject): string {
  const text = message.type === "user" && typeof message.text === "string"
    ? recentEntry("User", message.text)
    : message.type === "assistant" && Array.isArray(message.content)
      ? message.content.flatMap((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? [recentEntry("Assistant", block.text)] : []).join("\n\n")
      : "";
  if (!text) return tailUtf8(previous, MAX_CONTINUATION_RECENT_BYTES);
  const textTail = tailUtf8(text, MAX_CONTINUATION_RECENT_BYTES);
  if (Buffer.byteLength(textTail, "utf8") >= MAX_CONTINUATION_RECENT_BYTES) return textTail;
  return tailUtf8(
    previous ? `${previous}\n\n${textTail}` : textTail,
    MAX_CONTINUATION_RECENT_BYTES,
  );
}

function addContinuationBoundaries(
  source: JsonObject[],
  session: SessionIR,
  diagnostics: Diagnostic[],
): JsonObject[] {
  const messages: JsonObject[] = [];
  let activeBytes = 0;
  let recent = "";
  let boundaries = 0;
  for (const message of source) {
    messages.push(message);
    activeBytes += contextBytes(message);
    recent = updateRecentContext(recent, message);
    if (message.type !== "assistant" || activeBytes <= MAX_CONTINUATION_CONTEXT_BYTES) continue;
    const time = isRecord(message.time) ? message.time : {};
    const created = typeof time.completed === "number"
      ? time.completed : typeof time.created === "number" ? time.created : session.updatedAt!;
    const retainedContext = recent ||
      "[Assistant]: Earlier imported TRAE messages remain stored in this session.";
    messages.push({
      id: `${String(message.id)}_compact`,
      type: "compaction",
      time: { created },
      status: "completed",
      reason: "manual",
      // OpenCode renders summary in the timeline; recent is model context only.
      summary: "",
      recent: retainedContext,
      metadata: { trae2opencode: {
        mappingVersion: 8,
        kind: "continuation-boundary",
        activeContextBytes: activeBytes,
      } },
    });
    boundaries++;
    activeBytes = Buffer.byteLength(retainedContext, "utf8");
  }
  if (boundaries > 0) {
    diagnostics.push(diagnostic(
      session,
      "T2O_OPENCODE_CONTINUATION_BOUNDARY",
      "Large imported history was divided by native compaction checkpoints so future prompts remain within a bounded active context.",
      "events",
    ));
  }
  return messages;
}

/** Pure mapping. No writes, timestamp synthesis, source guessing, or input mutation. */
export function mapOpenCodeSession(
  value: MigrationBundle,
  sourceSessionId: string,
  options: OpenCodeMappingOptions,
): OpenCodeMapping {
  const bundle = assertMigrationBundle(value);
  assertTraeParserCapability(bundle.source.product.version, bundle.source.profile, "assistant-messages");
  const session = bundle.sessions.find((candidate) => candidate.sourceId === sourceSessionId);
  if (!session) throw new Trae2OpenCodeError("T2O_OPENCODE_MAPPING_REJECTED");
  if (bundle.source.profile.verification !== "verified") reject(session, "source.profile.verification");
  const issues = [...bundle.diagnostics, ...validateMigrationBundleIntegrity(bundle)]
    .filter((issue) => concernsSession(issue, session));
  const canProjectPartialIssue = (issue: Diagnostic) =>
    session.recovery === "partial" &&
    issue.subject?.type === "session" &&
    issue.subject.sourceId === session.sourceId &&
    PARTIAL_PROJECTION_CODES.has(issue.code);
  const blockers = issues.filter((issue) =>
    (issue.severity === "error" || issue.code === "T2O_TRAE_TOOL_ERROR_UNVERIFIED") &&
    !canProjectPartialIssue(issue));
  if (blockers.length > 0) reject(session, "diagnostics");
  const hasMessages = session.events.length > 0;
  const isRecoverable = session.recovery === "complete" || session.recovery === "partial";
  if (!hasMessages || !isRecoverable) reject(session, "recovery");
  if (session.createdAt === undefined || session.updatedAt === undefined) reject(session, "time");
  const hasMatchingParent = Boolean(session.parentSourceId) === Boolean(options.parentId);
  if (!hasMatchingParent || options.parentId === options.sessionId) reject(session, "parentSourceId");
  if (!options.directory || options.directory.includes("\0")) reject(session, "directory");
  const targetIds = session.events.map((event) => options.messageIds.get(event.sourceId));
  const validIds = targetIds.every((id) => typeof id === "string" && /^msg_[a-zA-Z0-9_-]+$/.test(id)) &&
    targetIds.every((id, index) => index === 0 || targetIds[index - 1]! < id!) &&
    new Set(targetIds).size === targetIds.length && /^ses_[a-zA-Z0-9_-]+$/.test(options.sessionId);
  if (!validIds) reject(session, "idMapping");
  const diagnostics = [
    diagnostic(session, "T2O_OPENCODE_SOURCE_FIELDS_UNKNOWN",
      "Target-required usage, agent and model defaults are explicitly marked as unknown source values."),
  ];
  const projectedSourceCodes = [...new Set(issues.filter(canProjectPartialIssue).map((issue) => issue.code))]
    .sort();
  if (projectedSourceCodes.length > 0) {
    diagnostics.push(diagnostic(
      session,
      "T2O_OPENCODE_PARTIAL_SOURCE_PROJECTION",
      "Recoverable source records were imported while explicitly diagnosed malformed records remained excluded.",
    ));
  }
  if (session.resources.length > 0) {
    diagnostics.push(diagnostic(session, "T2O_OPENCODE_RESOURCES_DEFERRED",
      "Resources remain in the IR; no message attachment association is inferred."));
  }
  const sourceMessages = session.events.map((event, index): JsonObject => {
    const field = `events[${index}]`;
    if (!hasVerifiedRuntimeRefs(event.sourceRefs, session.sourceId)) reject(session, `${field}.sourceRefs`);
    if (event.createdAt === undefined) reject(session, `${field}.createdAt`);
    const validReply = hasValidReply(session, event);
    if (event.type === "assistant" && !validReply) {
      diagnostics.push(diagnostic(
        session,
        "T2O_OPENCODE_REPLY_REFERENCE_UNRESOLVED",
        "An assistant reply target was absent or invalid; the unresolved source relation remains in metadata.",
        `${field}.replyToSourceId`,
      ));
    }
    const common = {
      id: targetIds[index]!,
      metadata: { trae2opencode: eventMetadata(event, validReply) },
    };
    if (event.type === "user") {
      return { ...common, type: "user", time: { created: event.createdAt }, text: event.text };
    }
    const projectsUnknownState = session.recovery === "partial" && event.status === "unknown";
    const hasFinalState = event.status === "completed" || event.status === "error" ||
      projectsUnknownState;
    if (!hasFinalState || event.completedAt === undefined) reject(session, `${field}.completedAt/status`);
    if (projectsUnknownState) {
      diagnostics.push(diagnostic(
        session,
        "T2O_OPENCODE_ASSISTANT_STATUS_PROJECTED",
        "An unknown TRAE assistant status is preserved with OpenCode's native unknown finish reason.",
        `${field}.status`,
      ));
    }
    const content: JsonObject[] = [];
    event.content.forEach((block, i) => {
      const mapped = mapContent(block, session, `${field}.content[${i}]`, diagnostics);
      if (!mapped) return;
      content.push(mapped);
    });
    const sourceTextMissing = session.recovery === "partial" &&
      issues.some((issue) =>
        issue.code === "T2O_TRAE_ASSISTANT_MESSAGE_TEXT_MISSING" &&
        concernsEvent(issue, event));
    if (sourceTextMissing && !content.some((block) => block.type === "text")) {
      content.push({ type: "text", text: MISSING_ASSISTANT_TEXT });
      diagnostics.push(diagnostic(
        session,
        "T2O_OPENCODE_ASSISTANT_TEXT_MISSING",
        "TRAE did not persist final assistant text; the target contains an explicit placeholder.",
        `${field}.content`,
      ));
    }
    return {
      ...common, type: "assistant",
      time: { created: event.createdAt, completed: event.completedAt },
      agent: "trae-import-unknown",
      model: { id: "unknown", providerID: "trae-import-unknown" },
      ...(event.status === "error" || projectsUnknownState
        ? { finish: event.status === "error" ? "error" : "unknown" }
        : {}),
      content,
    };
  });
  const messages = addContinuationBoundaries(sourceMessages, session, diagnostics);
  const transfer: OpenCodeTransfer = {
    info: {
      id: options.sessionId, projectID: "trae-import-unassigned",
      ...(options.parentId ? { parentID: options.parentId } : {}),
      ...(session.title === undefined ? {} : { title: session.title }),
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: session.createdAt, updated: session.updatedAt },
      location: { directory: options.directory },
      metadata: { trae2opencode: {
        mappingVersion: 8, sourceSessionId: session.sourceId,
        sourceSessionSha256: hashCanonicalJson(session as unknown as JsonValue),
        unknownSourceFields: ["cost", "tokens", "agent", "model"],
        resourceCount: session.resources.length,
        sourceRecovery: session.recovery,
        sourceDiagnosticCodes: [...new Set(issues.map((issue) => issue.code))].sort(),
        ...(projectedSourceCodes.length > 0 ? { projectedSourceCodes } : {}),
      } },
    },
    messages,
  };
  assertOpenCodeTransfer(transfer);
  return { transfer: structuredClone(transfer), diagnostics };
}
