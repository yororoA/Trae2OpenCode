import { hashCanonicalJson } from "../../../ir/canonical.js";
import type { Diagnostic, JsonObject, JsonValue, MigrationBundle } from "../../../ir/types.js";
import { Trae2OpenCodeError } from "../../../shared/errors.js";
import { isRecord } from "../contract.js";
import {
  mapOpenCodeSession, type OpenCodeMapping, type OpenCodeMappingOptions, type OpenCodeSession,
} from "../mapping.js";
import { assertOpenCodeV1Session } from "./contract.js";

/** v1 uses role-based messages with native `parts`, so message metadata has no home there. */
export const V1_MAPPING_VERSION = 8;

export interface OpenCodeV1Session extends OpenCodeSession {
  info: JsonObject & {
    id: string;
    directory: string;
    version: string;
    time: { created: number; updated: number };
    parentID?: string;
    title?: string;
  };
}

export interface OpenCodeV1Mapping {
  transfer: OpenCodeV1Session;
  diagnostics: Diagnostic[];
}

export interface OpenCodeV1MappingOptions extends OpenCodeMappingOptions {
  /** The verified v1 executable version; a v1 session persists its own version string. */
  targetVersion: string;
}

const UNKNOWN_AGENT = "trae-import-unknown";
const UNKNOWN_MODEL = "unknown";
const ZERO_TOKENS: JsonObject = {
  input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 },
};

/** States v1 cannot express without inventing data that TRAE never persisted. */
const UNSUPPORTED_STATES: Record<string, string> = {
  "assistant.reply":
    "A v1 assistant message requires the target identity of the user message it replies to.",
  "assistant.completedAt":
    "A v1 assistant message requires a persisted completion time.",
  "tool.content":
    "A v1 completed tool state accepts exactly one persisted text output.",
};

/**
 * v1 requires part timestamps that TRAE never persists per content block. The containing
 * assistant turn carries the only persisted time evidence, so it is projected and reported.
 */
const PROJECTION_CODES: Record<string, { code: string; message: string }> = {
  "part.start": {
    code: "T2O_OPENCODE_V1_PART_START_PROJECTED",
    message: "OpenCode 1.x requires a part start time; the containing assistant turn's creation time is used instead.",
  },
  "part.end": {
    code: "T2O_OPENCODE_V1_PART_END_PROJECTED",
    message: "OpenCode 1.x requires a completion time here; the containing assistant turn's completion time is used instead.",
  },
};

function v1Diagnostic(
  sourceSessionId: string, code: string, message: string, field?: string,
): Diagnostic {
  return {
    id: hashCanonicalJson({ session: sourceSessionId, code, field: field ?? null }),
    code, message, severity: "warning",
    subject: { type: "session", sourceId: sourceSessionId },
    sourceRefs: [],
    ...(field ? { context: { field } } : {}),
  };
}

function reject(sourceSessionId: string, reason: keyof typeof UNSUPPORTED_STATES): never {
  const issue = v1Diagnostic(
    sourceSessionId, "T2O_OPENCODE_V1_UNSUPPORTED_STATE", UNSUPPORTED_STATES[reason], reason,
  );
  issue.severity = "error";
  throw new Trae2OpenCodeError("T2O_OPENCODE_V1_UNSUPPORTED_STATE", { diagnostics: [issue] });
}

function marker(message: JsonObject): Record<string, unknown> {
  const metadata = isRecord(message.metadata) ? message.metadata : undefined;
  const value = metadata?.trae2opencode;
  return isRecord(value) ? value : {};
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function blockTime(block: JsonObject): { start?: number; end?: number } {
  const time = isRecord(block.time) ? block.time : {};
  return {
    ...(num(time.created) === undefined ? {} : { start: num(time.created) }),
    ...(num(time.completed) === undefined ? {} : { end: num(time.completed) }),
  };
}

/** The assistant turn supplies the only persisted time evidence for its content blocks. */
interface TurnTime {
  created: number;
  completed: number;
}

function partTime(
  time: { start?: number; end?: number },
  turn: TurnTime,
  requireEnd: boolean,
  projections: Set<string>,
): JsonObject {
  const start = time.start ?? turn.created;
  if (time.start === undefined) projections.add("part.start");
  if (!requireEnd) return { start };
  const end = time.end ?? turn.completed;
  if (time.end === undefined) projections.add("part.end");
  return { start, end };
}

/** v1 reads a message's parts back ordered by part id, so ids must encode that order. */
function partId(sessionId: string, messageId: string, index: number): string {
  return `prt_${index.toString(16).padStart(16, "0")}_t2o_${hashCanonicalJson({
    sessionId, messageId, index, namespace: "trae-cn",
  }).slice(7, 31)}`;
}

/** Translate one v2 assistant content block into a v1 part. */
function mapBlock(
  block: JsonObject, sourceSessionId: string, sessionId: string, messageId: string, index: number,
  turn: TurnTime, projections: Set<string>,
): JsonObject {
  const common = { id: partId(sessionId, messageId, index), sessionID: sessionId, messageID: messageId };
  const time = blockTime(block);
  if (block.type === "text") {
    return {
      ...common, type: "text", text: text(block.text) ?? "",
      ...(time.start === undefined ? {} : { time: { start: time.start } }),
    };
  }
  if (block.type === "reasoning") {
    const metadata = isRecord(block.metadata) ? block.metadata : undefined;
    return {
      ...common, type: "reasoning", text: text(block.text) ?? "",
      time: partTime(time, turn, true, projections),
      ...(metadata === undefined ? {} : { metadata }),
    };
  }
  if (block.type !== "tool") reject(sourceSessionId, "tool.content");
  const state = isRecord(block.state) ? block.state : {};
  const metadata = isRecord(state.metadata) ? (state.metadata as JsonObject) : {};
  const tool = {
    ...common, type: "tool",
    callID: text(block.id) ?? "",
    tool: text(block.name) ?? UNKNOWN_AGENT,
  };
  const status = text(state.status);
  if (status === "streaming") {
    // v1 has no streaming state; the partial payload survives verbatim as pending raw input.
    // v1's pending state carries no metadata field, and the streamed payload has none either.
    return {
      ...tool,
      state: { status: "pending", input: {}, raw: text(state.input) ?? "" },
    };
  }
  const input = isRecord(state.input) ? (state.input as JsonObject) : {};
  if (status === "running") {
    return { ...tool, state: { status: "running", input, metadata, time: partTime(time, turn, false, projections) } };
  }
  if (status === "completed") {
    const content = Array.isArray(state.content) ? state.content : [];
    const outputs = content.flatMap((item) =>
      isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []);
    if (content.length !== 1 || outputs.length !== 1) reject(sourceSessionId, "tool.content");
    return {
      ...tool,
      state: {
        status: "completed", input, output: outputs[0], metadata,
        // v1 requires a display title; the mapped tool name is the only verified label.
        title: tool.tool,
        time: partTime(time, turn, true, projections),
      },
    };
  }
  if (status === "error") {
    // v1 keeps no visible output on a failed tool, so a persisted payload moves into metadata.
    const errorMarker: JsonObject = { ...(marker(state) as JsonObject) };
    if (Array.isArray(state.content) && state.content.length > 0) {
      errorMarker.outputContent = state.content as JsonValue;
    }
    return {
      ...tool,
      state: {
        status: "error", input, error: text((state.error as JsonObject | undefined)?.message) ?? "",
        metadata: { ...metadata, trae2opencode: errorMarker },
        time: partTime(time, turn, true, projections),
      },
    };
  }
  reject(sourceSessionId, "tool.content");
}

/** v1 orders messages by `time.created` and then by id; send them in exactly that order. */
function inV1Order(messages: JsonObject[]): { messages: JsonObject[]; reordered: boolean } {
  const sorted = [...messages].sort((left, right) => {
    const leftTime = num(isRecord(left.time) ? left.time.created : undefined) ?? 0;
    const rightTime = num(isRecord(right.time) ? right.time.created : undefined) ?? 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left.id).localeCompare(String(right.id));
  });
  return {
    messages: sorted,
    reordered: sorted.some((message, index) => message.id !== messages[index].id),
  };
}

/**
 * v1 payloads are derived from the reviewed v2 projection, so every source-side
 * validation, blocking rule and diagnostic in `mapOpenCodeSession` still applies.
 */
export function mapOpenCodeV1Session(
  value: MigrationBundle,
  sourceSessionId: string,
  options: OpenCodeV1MappingOptions,
): OpenCodeV1Mapping {
  const v2: OpenCodeMapping = mapOpenCodeSession(value, sourceSessionId, options);
  const transfer = v2.transfer;
  const info = transfer.info;
  const directory = info.location.directory;
  const sessionId = String(info.id);
  const v2Marker = marker({ metadata: info.metadata });
  const diagnostics = v2.diagnostics.filter((issue) =>
    issue.code !== "T2O_OPENCODE_CONTINUATION_BOUNDARY");
  const boundaries = v2.diagnostics.filter((issue) =>
    issue.code === "T2O_OPENCODE_CONTINUATION_BOUNDARY").length;
  const targetBySource = new Map<string, string>();
  for (const message of transfer.messages) {
    const sourceId = text(marker(message).sourceId);
    if (sourceId !== undefined) targetBySource.set(sourceId, String(message.id));
  }

  const events: JsonObject[] = [];
  const messages: JsonObject[] = [];
  const projections = new Set<string>();
  let projectedStreaming = 0;

  for (const message of transfer.messages) {
    // v1 has no compaction message type and no summary-carrying part, so checkpoints stay out.
    if (text(message.type) === "compaction") continue;
    const sourceMarker = marker(message);
    const time = isRecord(message.time) ? message.time : {};
    const created = num(time.created) ?? 0;
    const messageId = String(message.id);
    events.push({
      sourceId: text(sourceMarker.sourceId) ?? null,
      order: num(sourceMarker.order) ?? null,
      turnSourceId: text(sourceMarker.turnSourceId) ?? null,
      replyToSourceId: text(sourceMarker.replyToSourceId) ?? null,
      replyReferenceStatus: text(sourceMarker.replyReferenceStatus) ?? null,
      status: text(sourceMarker.status) ?? null,
      ...(Array.isArray(sourceMarker.content) ? { content: sourceMarker.content } : {}),
    });
    if (text(message.type) === "user") {
      messages.push({
        info: {
          id: messageId, sessionID: sessionId, role: "user", time: { created },
          agent: UNKNOWN_AGENT, model: { providerID: UNKNOWN_AGENT, modelID: UNKNOWN_MODEL },
        },
        parts: [{
          id: partId(sessionId, messageId, 0), sessionID: sessionId, messageID: messageId,
          type: "text", text: text(message.text) ?? "",
        }],
      });
      continue;
    }
    if (text(message.type) !== "assistant") reject(sourceSessionId, "assistant.reply");
    const reply = text(sourceMarker.replyToSourceId);
    const parentID = reply === undefined ? undefined : targetBySource.get(reply);
    if (parentID === undefined) reject(sourceSessionId, "assistant.reply");
    const completed = num(time.completed);
    if (completed === undefined) reject(sourceSessionId, "assistant.completedAt");
    const parts: JsonObject[] = [];
    const turn: TurnTime = { created, completed };
    for (const block of (Array.isArray(message.content) ? message.content : [])) {
      if (!isRecord(block)) continue;
      if (block.type === "tool" && isRecord(block.state) && block.state.status === "streaming") {
        projectedStreaming++;
      }
      parts.push(mapBlock(block, sourceSessionId, sessionId, messageId, parts.length, turn, projections));
    }
    const finish = text(message.finish);
    messages.push({
      info: {
        id: messageId, sessionID: sessionId, role: "assistant",
        time: { created, completed },
        parentID, modelID: UNKNOWN_MODEL, providerID: UNKNOWN_AGENT,
        mode: UNKNOWN_AGENT, agent: UNKNOWN_AGENT,
        path: { cwd: directory, root: directory },
        cost: 0, tokens: structuredClone(ZERO_TOKENS),
        ...(finish === undefined ? {} : { finish }),
      },
      parts,
    });
  }

  const ordered = inV1Order(messages);
  if (ordered.reordered) {
    diagnostics.push(v1Diagnostic(
      sourceSessionId, "T2O_OPENCODE_V1_MESSAGE_ORDER_NORMALIZED",
      "OpenCode 1.x orders messages by creation time and id; the payload was sent in that order so the readback proves it.",
      "events",
    ));
  }
  if (boundaries > 0) {
    diagnostics.push(v1Diagnostic(
      sourceSessionId, "T2O_OPENCODE_V1_CONTINUATION_BOUNDARY_OMITTED",
      "OpenCode 1.x has no summary-carrying compaction message; the transcript was imported undivided and should be summarized natively before a long continuation.",
      "events",
    ));
  }
  if (projectedStreaming > 0) {
    diagnostics.push(v1Diagnostic(
      sourceSessionId, "T2O_OPENCODE_V1_TOOL_STATUS_PROJECTED",
      "An interrupted TRAE tool is represented as pending raw input, which is what v1 can persist without inventing a result.",
      "events",
    ));
  }
  for (const field of ["part.start", "part.end"]) {
    if (!projections.has(field)) continue;
    const projection = PROJECTION_CODES[field];
    diagnostics.push(v1Diagnostic(sourceSessionId, projection.code, projection.message, field));
  }
  diagnostics.push(v1Diagnostic(
    sourceSessionId, "T2O_OPENCODE_V1_PROVENANCE_AT_SESSION",
    "OpenCode 1.x messages carry no metadata, so per-event provenance is preserved on the session instead.",
    "info.metadata",
  ));

  const sessionParentID = text(info.parentID);
  const sessionTitle = text(info.title);
  const v1Transfer: OpenCodeV1Session = {
    info: {
      id: sessionId,
      slug: `trae-import-${sessionId.slice(4, 12)}`,
      projectID: "trae-import-unassigned",
      ...(sessionParentID === undefined ? {} : { parentID: sessionParentID }),
      ...(sessionTitle === undefined ? {} : { title: sessionTitle }),
      directory,
      version: options.targetVersion,
      agent: UNKNOWN_AGENT,
      model: { id: UNKNOWN_MODEL, providerID: UNKNOWN_AGENT },
      cost: 0, tokens: structuredClone(ZERO_TOKENS),
      time: { created: info.time.created, updated: info.time.updated },
      metadata: { trae2opencode: {
        mappingVersion: V1_MAPPING_VERSION,
        dialect: "v1",
        targetVersion: options.targetVersion,
        sourceSessionId,
        sourceSessionSha256: text(v2Marker.sourceSessionSha256) ?? null,
        sourceRecovery: text(v2Marker.sourceRecovery) ?? null,
        sourceDiagnosticCodes: Array.isArray(v2Marker.sourceDiagnosticCodes)
          ? v2Marker.sourceDiagnosticCodes : [],
        unknownSourceFields: ["cost", "tokens", "agent", "model"],
        projectedSourceCodes: Array.isArray(v2Marker.projectedSourceCodes)
          ? v2Marker.projectedSourceCodes : [],
        resourceCount: num(v2Marker.resourceCount) ?? 0,
        eventCount: events.length,
        continuationBoundariesOmitted: boundaries,
        events,
      } },
    },
    messages: ordered.messages,
  };
  assertOpenCodeV1Session(v1Transfer);
  return { transfer: structuredClone(v1Transfer), diagnostics };
}