import { canonicalizeJson, hashCanonicalJson } from "../../ir/canonical.js";
import { validateMigrationBundleIntegrity } from "../../ir/integrity.js";
import type {
  AssistantContentIR, Diagnostic, EventIR, JsonObject, JsonValue,
  MigrationBundle, SessionIR, SourceRef,
} from "../../ir/types.js";
import { assertMigrationBundle } from "../../ir/validation.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  assertTraeParserCapability, RUNTIME_PROFILE,
} from "../../source/trae/profile-definitions.js";
import { assertOpenCodeTransfer, isRecord } from "./contract.js";

export interface OpenCodeTransfer {
  info: JsonObject & {
    id: string;
    time: { created: number; updated: number };
    location: { directory: string };
  };
  messages: JsonObject[];
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

function hasErrorPayload(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return false;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

function mapContent(
  block: AssistantContentIR,
  session: SessionIR,
  field: string,
  diagnostics: Diagnostic[],
): JsonObject {
  if (!hasVerifiedRuntimeRefs(block.sourceRefs, session.sourceId)) reject(session, `${field}.sourceRefs`);
  const time = block.createdAt === undefined ? undefined : {
    created: block.createdAt,
    ...(block.completedAt === undefined ? {} : { completed: block.completedAt }),
  };
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "reasoning") {
    return { type: "reasoning", text: block.text, ...(time ? { time } : {}) };
  }
  if (!time) reject(session, `${field}.createdAt`);
  const rejectsToolState = block.status === "unknown" || block.status === "error" ||
    hasErrorPayload(block.error);
  if (rejectsToolState) reject(session, `${field}.status`);
  let state: JsonObject;
  if (block.status === "streaming") {
    if (typeof block.input !== "string" || block.output !== undefined) reject(session, `${field}.input/output`);
    state = { status: "streaming", input: block.input };
  } else {
    if (!isRecord(block.input)) reject(session, `${field}.input`);
    if (block.status === "running") {
      if (block.output !== undefined) reject(session, `${field}.output`);
      state = { status: "running", input: block.input as JsonObject, metadata: {} };
    } else {
      if (block.completedAt === undefined) reject(session, `${field}.completedAt`);
      const sourceOutputMissing = block.output === undefined;
      const output = sourceOutputMissing ? MISSING_TOOL_OUTPUT_TEXT : block.output;
      const isText = typeof output === "string";
      const text = isText ? output as string : canonicalizeJson(output as JsonValue);
      if (sourceOutputMissing) {
        diagnostics.push(diagnostic(
          session,
          "T2O_OPENCODE_TOOL_OUTPUT_MISSING",
          "TRAE marked a tool completed without persisting output; the target contains an explicit placeholder.",
          `${field}.output`,
        ));
      }
      state = {
        status: "completed", input: block.input as JsonObject,
        content: [{ type: "text", text }],
        metadata: { trae2opencode: {
          outputEncoding: isText ? "text" : "canonical-json",
          outputSha256: hashCanonicalJson(output as JsonValue),
          ...(sourceOutputMissing ? { sourceOutputMissing: true } : {}),
        } },
      };
    }
  }
  return { type: "tool", id: block.callId, name: block.name, time, state };
}

function eventMetadata(event: EventIR): JsonObject {
  return {
    sourceId: event.sourceId, order: event.order,
    ...(event.turnSourceId ? { turnSourceId: event.turnSourceId } : {}),
    ...(event.replyToSourceId ? { replyToSourceId: event.replyToSourceId } : {}),
    ...(event.type === "assistant" ? {
      status: event.status,
      unknownSourceFields: ["agent", "model"],
      // Text has no native time field; the parallel metadata preserves every block's time.
      content: event.content.map((block) => ({
        ...(block.createdAt === undefined ? {} : { createdAt: block.createdAt }),
        ...(block.completedAt === undefined ? {} : { completedAt: block.completedAt }),
      })),
    } : {}),
  };
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
  const issues = [...bundle.diagnostics, ...validateMigrationBundleIntegrity(bundle)];
  const blockers = issues.filter((issue) => concernsSession(issue, session) &&
    (issue.severity === "error" || issue.code === "T2O_TRAE_TOOL_ERROR_UNVERIFIED"));
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
    new Set(targetIds).size === targetIds.length && /^ses_[a-zA-Z0-9_-]+$/.test(options.sessionId);
  if (!validIds) reject(session, "idMapping");
  const diagnostics = [
    diagnostic(session, "T2O_OPENCODE_SOURCE_FIELDS_UNKNOWN",
      "Target-required usage, agent and model defaults are explicitly marked as unknown source values."),
  ];
  if (session.resources.length > 0) {
    diagnostics.push(diagnostic(session, "T2O_OPENCODE_RESOURCES_DEFERRED",
      "Resources remain in the IR; no message attachment association is inferred."));
  }
  const messages = session.events.map((event, index): JsonObject => {
    const field = `events[${index}]`;
    if (!hasVerifiedRuntimeRefs(event.sourceRefs, session.sourceId)) reject(session, `${field}.sourceRefs`);
    if (event.createdAt === undefined) reject(session, `${field}.createdAt`);
    const common = {
      id: targetIds[index]!,
      metadata: { trae2opencode: eventMetadata(event) },
    };
    if (event.type === "user") {
      return { ...common, type: "user", time: { created: event.createdAt }, text: event.text };
    }
    const hasFinalState = event.status === "completed" || event.status === "error";
    if (!hasFinalState || event.completedAt === undefined) reject(session, `${field}.completedAt/status`);
    return {
      ...common, type: "assistant",
      time: { created: event.createdAt, completed: event.completedAt },
      agent: "trae-import-unknown",
      model: { id: "unknown", providerID: "trae-import-unknown" },
      ...(event.status === "error" ? { finish: "error" } : {}),
      content: event.content.map((block, i) =>
        mapContent(block, session, `${field}.content[${i}]`, diagnostics)),
    };
  });
  const transfer: OpenCodeTransfer = {
    info: {
      id: options.sessionId, projectID: "trae-import-unassigned",
      ...(options.parentId ? { parentID: options.parentId } : {}),
      ...(session.title === undefined ? {} : { title: session.title }),
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: session.createdAt, updated: session.updatedAt },
      location: { directory: options.directory },
      metadata: { trae2opencode: {
        mappingVersion: 1, sourceSessionId: session.sourceId,
        sourceSessionSha256: hashCanonicalJson(session as unknown as JsonValue),
        unknownSourceFields: ["cost", "tokens", "agent", "model"],
        resourceCount: session.resources.length,
      } },
    },
    messages,
  };
  assertOpenCodeTransfer(transfer);
  return { transfer: structuredClone(transfer), diagnostics };
}
