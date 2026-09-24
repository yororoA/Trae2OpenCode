import type {
  AssistantContentIR, Diagnostic, EventIR, JsonObject, MigrationBundle, ProjectIR,
  ResourceRef, SessionIR, SourceRef,
} from "../../ir/types.js";
import { validateMigrationBundleIntegrity } from "../../ir/integrity.js";
import { assertMigrationBundle } from "../../ir/validation.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import type { TraeAssistantMessage } from "./assistant-messages.js";
import { createTraeParser } from "./parser-registry.js";
import { RUNTIME_PROFILE, WORKSPACE_PROFILE } from "./profile-definitions.js";
import { runtimeHash } from "./reasoning-plan.js";
import { gradeSessionRecovery } from "./recovery-grading.js";
import type { TraeResourceReport, TraeResourceSource } from "./resources.js";
import type { TraeSessionMetadata, TraeSessionMetadataReport } from "./session-metadata.js";
import type { TraeUserMessage } from "./user-messages.js";
import type { WorkspaceResolutionReport } from "./workspace-resolution.js";

export type TraeSessionMessageRead = {
  sourceSessionId: string;
} & (
  | { status: "available"; value: unknown; expectedMessageCount?: number }
  | { status: "unavailable" | "error" }
);

export interface AssembleTraeBundleOptions {
  productVersion: string;
  platform: MigrationBundle["source"]["platform"];
  collectedAt: string;
  metadata: TraeSessionMetadataReport;
  workspaces: WorkspaceResolutionReport;
  messageReads: readonly TraeSessionMessageRead[];
  resources: TraeResourceReport;
  /** Inventory only: cache entries without a session identity never become events. */
  queryCacheHashes?: readonly string[];
}

interface SourceIssue {
  code: string;
  severity: "warning" | "error";
  message: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  workspaceStorageId?: string;
  contentLocator?: string;
  entryIndex?: number;
}

function uniqueRefs(refs: SourceRef[]): SourceRef[] {
  return [...new Map(refs.map((ref) => [runtimeHash(ref), ref])).entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([, ref]) => ref);
}

function runtimeRefs(
  sessionId: string, workspaces: readonly string[], locator: string, sha256: string,
): SourceRef[] {
  return (workspaces.length > 0 ? [...new Set(workspaces)].sort() : [null]).map((workspaceStorageId) => ({
    workspaceStorageId, sourceSessionId: sessionId,
    locator: { type: "runtime-field", value: locator }, parserProfile: { ...RUNTIME_PROFILE }, sha256,
  }));
}

function messageLocator(id: string, field?: string): string {
  return `runtime:getMessages#message[${JSON.stringify(id)}]${field ? `.${field}` : ""}`;
}

function metadataRefs(metadata: TraeSessionMetadata): SourceRef[] {
  return uniqueRefs(metadata.sources.map((source): SourceRef => ({
    workspaceStorageId: source.workspaceStorageId ?? null,
    sourceSessionId: metadata.sourceSessionId,
    locator: {
      type: source.kind === "runtime-metadata" ? "runtime-field" :
        source.kind === "snapshot-directory" ? "relative-path" : "database-key",
      value: source.locator,
    },
    parserProfile: { ...(source.kind === "runtime-metadata" ? RUNTIME_PROFILE : WORKSPACE_PROFILE) },
    sha256: source.sha256,
  })));
}

function resourceRef(source: TraeResourceSource): SourceRef {
  return {
    workspaceStorageId: source.workspaceStorageId, sourceSessionId: source.sourceSessionId ?? null,
    locator: {
      type: source.kind === "workspace-resource" ? "relative-path" :
        source.kind === "query-cache-reference" ? "database-key" : "workspace-state",
      value: source.locator,
    },
    parserProfile: { ...WORKSPACE_PROFILE }, sha256: source.sha256,
  };
}

function assistantContent(message: TraeAssistantMessage, workspaces: string[]): AssistantContentIR[] {
  const refs = (source: { locator: string; sha256: string }) =>
    runtimeRefs(message.sourceSessionId, workspaces, messageLocator(message.sourceMessageId, source.locator), source.sha256);
  const blocks: { index: number; rank: number; block: AssistantContentIR }[] = [];
  for (const text of message.textBlocks) {
    const match = /^content\.messages\[(\d+)\]/.exec(text.source.locator);
    blocks.push({
      index: match ? Number(match[1]) : -1, rank: 1,
      block: { type: "text", text: text.text, sourceRefs: refs(text.source) },
    });
  }
  for (const reasoning of message.reasoningBlocks) {
    blocks.push({
      index: reasoning.entryIndex, rank: 0,
      block: { type: "reasoning", text: reasoning.text, sourceRefs: refs(reasoning.source) },
    });
  }
  for (const tool of message.toolCalls) {
    const createdAt = tool.startedAt ?? tool.generatedAt;
    blocks.push({
      index: tool.entryIndex, rank: 2,
      block: {
        type: "tool", callId: tool.callId, name: tool.name, input: tool.input, status: tool.status,
        ...(tool.output === undefined ? {} : { output: tool.output }),
        ...(tool.error === undefined ? {} : { error: tool.error }),
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(tool.completedAt === undefined ? {} : { completedAt: tool.completedAt }),
        sourceRefs: uniqueRefs(tool.sources.flatMap(refs)),
      },
    });
  }
  return blocks.sort((a, b) => a.index - b.index || a.rank - b.rank).map(({ block }) => block);
}

function eventIR(message: TraeUserMessage | TraeAssistantMessage, workspaces: string[]): EventIR {
  const sourceRefs = message.sources.flatMap((source) =>
    runtimeRefs(message.sourceSessionId, workspaces, messageLocator(message.sourceMessageId), source.sha256));
  const base = {
    sourceId: message.sourceMessageId, order: message.order, createdAt: message.createdAt,
    sourceRefs: uniqueRefs(sourceRefs),
  };
  if ("text" in message) {
    base.sourceRefs = uniqueRefs([
      ...base.sourceRefs,
      ...runtimeRefs(message.sourceSessionId, workspaces,
        messageLocator(message.sourceMessageId, message.textSource.locator), message.textSource.sha256),
    ]);
    return { ...base, type: "user", text: message.text };
  }
  return {
    ...base, type: "assistant", turnSourceId: message.turnId, replyToSourceId: message.replyToMessageId,
    status: message.status === "in-progress" ? "running" : message.status,
    ...(message.completedAt === undefined ? {} : { completedAt: message.completedAt }),
    content: assistantContent(message, workspaces),
  };
}

/** Pure assembly. Runtime availability/counts must come from an actual read contract. */
export function assembleTraeMigrationBundle(options: AssembleTraeBundleOptions): MigrationBundle {
  const runtime = createTraeParser({
    productVersion: options.productVersion, profileId: RUNTIME_PROFILE.id, profileVersion: RUNTIME_PROFILE.version,
  });
  if (runtime.kind !== "runtime") throw new Trae2OpenCodeError("T2O_TRAE_BUNDLE_INPUT_INVALID");
  if (options.metadata.productVersion !== options.productVersion) {
    throw new Trae2OpenCodeError("T2O_TRAE_BUNDLE_INPUT_INVALID");
  }
  const diagnostics: Diagnostic[] = [];
  const add = (issue: SourceIssue, refs: SourceRef[] = [], sessionId = issue.sourceSessionId) => {
    const context: JsonObject = {
      ...(issue.workspaceStorageId ? { workspaceStorageId: issue.workspaceStorageId } : {}),
      ...(issue.sourceMessageId ? { sourceMessageId: issue.sourceMessageId } : {}),
      ...(issue.contentLocator ? { contentLocator: issue.contentLocator } : {}),
      ...(issue.entryIndex === undefined ? {} : { entryIndex: issue.entryIndex }),
    };
    const diagnostic: Omit<Diagnostic, "id"> = {
      code: issue.code, severity: issue.severity, message: issue.message,
      subject: sessionId ? { type: "session", sourceId: sessionId } : { type: "bundle" },
      sourceRefs: uniqueRefs(refs), ...(Object.keys(context).length ? { context } : {}),
    };
    diagnostics.push({ id: runtimeHash(diagnostic), ...diagnostic });
  };
  const warn = (code: string, message: string, sourceSessionId?: string, refs: SourceRef[] = []) =>
    add({ code, message, severity: "warning", sourceSessionId }, refs);
  const metadata = new Map<string, TraeSessionMetadata>();
  for (const session of options.metadata.sessions) {
    const existing = metadata.get(session.sourceSessionId);
    if (existing && runtimeHash(existing) !== runtimeHash(session)) {
      throw new Trae2OpenCodeError("T2O_TRAE_BUNDLE_INPUT_INVALID");
    }
    metadata.set(session.sourceSessionId, session);
  }
  const reads = new Map<string, TraeSessionMessageRead>();
  for (const read of options.messageReads) {
    const validCount = read.status !== "available" || read.expectedMessageCount === undefined ||
      (Number.isSafeInteger(read.expectedMessageCount) && read.expectedMessageCount >= 0);
    const existing = reads.get(read.sourceSessionId);
    const conflictingRead = existing && runtimeHash(existing) !== runtimeHash(read);
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(read.sourceSessionId) || !validCount || conflictingRead) {
      throw new Trae2OpenCodeError("T2O_TRAE_BUNDLE_INPUT_INVALID");
    }
    reads.set(read.sourceSessionId, read);
  }
  for (const issue of options.metadata.issues) {
    const session = issue.sourceSessionId ? metadata.get(issue.sourceSessionId) : undefined;
    add(issue, session ? metadataRefs(session) : []);
  }
  for (const issue of options.workspaces.issues) add(issue);
  for (const issue of options.resources.issues) {
    if (issue.sourceSessionId) add(issue, [], issue.sourceSessionId);
    else add({ ...issue, severity: "warning" });
  }

  const projectsByPath = new Map<string, ProjectIR>();
  const workspaceProjects = new Map<string, Set<string>>();
  for (const workspace of options.workspaces.workspaces) {
    const ids = workspaceProjects.get(workspace.workspaceStorageId) ?? new Set<string>();
    workspaceProjects.set(workspace.workspaceStorageId, ids);
    for (const project of workspace.projects) {
      const key = options.platform === "win32" ? project.path.toLowerCase() : project.path;
      const sourceId = runtimeHash({ platform: options.platform, path: key });
      ids.add(sourceId);
      const sourceRef: SourceRef = {
        workspaceStorageId: workspace.workspaceStorageId, sourceSessionId: null,
        locator: { type: "workspace-state", value: `workspace.json#resolved-project:${sourceId}` },
        parserProfile: { ...WORKSPACE_PROFILE },
        sha256: runtimeHash({ path: project.path, source: project.source }),
      };
      const existing = projectsByPath.get(key);
      const representativePath = [existing?.path ?? project.path, project.path].sort()[0];
      projectsByPath.set(key, {
        sourceId, path: representativePath, sourceRefs: uniqueRefs([...(existing?.sourceRefs ?? []), sourceRef]),
      });
    }
  }
  const projects = [...projectsByPath.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const sessions: SessionIR[] = [];
  const sessionIds = [...new Set([...metadata.keys(), ...reads.keys()])].sort();
  const sessionIdSet = new Set(sessionIds);
  const resourcesBySession = new Map<string, ResourceRef[]>();
  for (const resource of options.resources.resources) {
    const { workspaceStorageId: _workspace, sources, references, ...ir } = resource;
    const linkedIds = new Set(references.flatMap((ref) =>
      ref.sourceSessionId && sessionIdSet.has(ref.sourceSessionId) ? [ref.sourceSessionId] : []));
    for (const id of linkedIds) {
      const associated = references.filter((ref) => ref.sourceSessionId === id);
      const list = resourcesBySession.get(id) ?? [];
      list.push({ ...ir, sourceRefs: uniqueRefs([...sources, ...associated].map(resourceRef)) });
      resourcesBySession.set(id, list);
    }
    if (linkedIds.size === 0) {
      const diagnostic: Omit<Diagnostic, "id"> = {
        code: "T2O_IR_RESOURCE_UNASSOCIATED", severity: "warning",
        message: "A resource has no explicit reference to a collected session.",
        subject: { type: "resource", sourceId: resource.sourceId },
        sourceRefs: uniqueRefs([...sources, ...references].map(resourceRef)),
        context: { ...ir },
      };
      diagnostics.push({ id: runtimeHash(diagnostic), ...diagnostic });
    }
  }
  for (const sourceId of sessionIds) {
    const meta = metadata.get(sourceId);
    const workspaceIds = meta?.workspaceStorageIds ?? [];
    const read = reads.get(sourceId) ?? { sourceSessionId: sourceId, status: "unavailable" as const };
    let sourceRefs = meta ? metadataRefs(meta) : [];
    const parsed = read.status === "available" ? {
      users: runtime.parseUserMessages(read.value), assistants: runtime.parseAssistantMessages(read.value),
    } : undefined;
    const parsedMessages = [...(parsed?.users.messages ?? []), ...(parsed?.assistants.messages ?? [])];
    const countsById = new Map<string, number>();
    for (const message of parsedMessages) {
      countsById.set(message.sourceMessageId, (countsById.get(message.sourceMessageId) ?? 0) + 1);
    }
    const events: EventIR[] = [];
    let invalidMessages = 0;
    for (const message of parsedMessages) {
      const foreignSession = message.sourceSessionId !== sourceId;
      const refs = runtimeRefs(message.sourceSessionId, foreignSession ? [] : workspaceIds,
        messageLocator(message.sourceMessageId), message.sources[0].sha256);
      const conflictingId = (countsById.get(message.sourceMessageId) ?? 0) > 1;
      if (foreignSession || conflictingId) {
        invalidMessages++;
        add({
          code: foreignSession ? "T2O_IR_MESSAGE_SESSION_MISMATCH" : "T2O_IR_EVENT_ID_CONFLICT",
          severity: "error", message: "A runtime message identity conflicts with its session or another role.",
          sourceSessionId: sourceId, sourceMessageId: message.sourceMessageId,
        }, refs);
      } else events.push(eventIR(message, workspaceIds));
    }
    events.sort((a, b) => a.order - b.order || a.sourceId.localeCompare(b.sourceId));
    sourceRefs = uniqueRefs([...sourceRefs, ...events.flatMap((event) => event.sourceRefs)]);
    const rawRefs = read.status === "available"
      ? runtimeRefs(sourceId, workspaceIds, "runtime:getMessages#response", runtimeHash(read.value)) : [];
    const parseIssues = [...(parsed?.users.issues ?? []), ...(parsed?.assistants.issues ?? [])];
    const eventsById = new Map(events.map((event) => [event.sourceId, event]));
    for (const issue of parseIssues) {
      const event = issue.sourceMessageId ? eventsById.get(issue.sourceMessageId) : undefined;
      add(issue, event?.sourceRefs ?? rawRefs, sourceId);
    }
    for (const event of events) {
      if (event.type !== "assistant") continue;
      const incompleteTool = event.content.some((block) =>
        block.type === "tool" &&
        (block.status !== "completed" && block.status !== "error" ||
          block.status === "completed" && block.output === undefined));
      if (event.status !== "completed" || incompleteTool) {
        warn("T2O_IR_CONTENT_INCOMPLETE", "An assistant message or tool has no verified terminal state.", sourceId, event.sourceRefs);
      }
    }
    if (sourceRefs.length === 0 && rawRefs.length > 0) sourceRefs = rawRefs;
    if (sourceRefs.length === 0) {
      // A request identifier is not evidence that a session exists.
      warn("T2O_IR_SESSION_WITHOUT_EVIDENCE", "A requested session has no recoverable source evidence.", sourceId);
      continue;
    }
    const resources = (resourcesBySession.get(sourceId) ?? []).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const projectIds = [...new Set(workspaceIds.flatMap((id) => [...(workspaceProjects.get(id) ?? [])]))];
    const project = projectIds.length === 1 ? projects.find((item) => item.sourceId === projectIds[0]) : undefined;
    if (!project) warn("T2O_IR_PROJECT_UNRESOLVED", "The session project is missing or ambiguous.", sourceId, sourceRefs);
    if (meta?.metadataStatus !== "complete") {
      warn("T2O_IR_METADATA_INCOMPLETE", "Session metadata is incomplete.", sourceId, sourceRefs);
    }
    const users = events.filter((event) => event.type === "user");
    const assistants = events.filter((event) => event.type === "assistant");
    const usersById = new Map(users.map((event) => [event.sourceId, event]));
    const assessment = gradeSessionRecovery({
      // The grading API requires an identity; this explicit runtime namespace is not a workspace claim in IR.
      workspaceStorageId: workspaceIds[0] ?? `runtime:${sourceId}`, sourceSessionId: sourceId,
      profileVerification: "verified", metadataAvailable: meta !== undefined && meta.metadataStatus !== "invalid",
      messageSource: read.status,
      ...(read.status !== "available" || read.expectedMessageCount === undefined ? {} :
        { expectedMessageCount: read.expectedMessageCount }),
      userMessages: users.length, userMessagesWithText: users.length,
      assistantMessages: assistants.length,
      assistantMessagesWithContent: assistants.filter((event) => event.content.length > 0).length,
      assistantMessagesWithCompletionTime: assistants.filter((event) => event.completedAt !== undefined).length,
      assistantMessagesLinkedToUser: assistants.filter((event) => {
        const user = event.replyToSourceId ? usersById.get(event.replyToSourceId) : undefined;
        return user !== undefined && user.order < event.order;
      }).length,
      invalidMessages, danglingReferences: resources.filter((resource) => resource.availability !== "available").length,
      sourceCorrupt: false,
    });
    for (const reason of assessment.missingReasons) warn(reason.code, reason.message, sourceId, sourceRefs);
    sessions.push({
      sourceId, ...(meta?.title === undefined ? {} : { title: meta.title }),
      ...(meta?.createdAt === undefined ? {} : { createdAt: meta.createdAt }),
      ...(meta?.updatedAt === undefined ? {} : { updatedAt: meta.updatedAt }),
      ...(meta?.parentSourceId === undefined ? {} : { parentSourceId: meta.parentSourceId }),
      ...(project ? { projectSourceId: project.sourceId, projectPath: project.path } : {}),
      recovery: assessment.recovery, events, resources, sourceRefs,
    });
  }
  const bundle: MigrationBundle = {
    schemaVersion: 1, createdAt: options.collectedAt,
    source: {
      product: { name: "trae-cn", version: options.productVersion }, platform: options.platform,
      profile: { ...RUNTIME_PROFILE, verification: "verified" }, collectedAt: options.collectedAt,
      sourceFingerprint: runtimeHash({
        sessions: sessions.map((session) => ({ id: session.sourceId, refs: session.sourceRefs })),
        projects: projects.map((project) => ({ id: project.sourceId, refs: project.sourceRefs })),
        resources: options.resources.resources.map((resource) => runtimeHash(resource)).sort(),
        queryCacheHashes: [...new Set(options.queryCacheHashes ?? [])].sort(),
        readStates: sessionIds.map((id) => {
          const read = reads.get(id);
          return {
            sourceSessionId: id, status: read?.status ?? "unavailable",
            ...(read?.status === "available" ? { expectedMessageCount: read.expectedMessageCount } : {}),
          };
        }),
        rejectedEvidence: uniqueRefs(diagnostics.flatMap((diagnostic) => diagnostic.sourceRefs)),
      }),
    },
    projects, sessions, diagnostics,
  };
  diagnostics.push(...validateMigrationBundleIntegrity(bundle));
  for (const session of sessions) {
    const incomplete = diagnostics.some((diagnostic) =>
      diagnostic.subject?.sourceId === session.sourceId && diagnostic.severity !== "info");
    if (session.recovery === "complete" && incomplete) session.recovery = "partial";
  }
  bundle.diagnostics = [...new Map(diagnostics.map((diagnostic) => [diagnostic.id, diagnostic])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));
  // Detach IR from mutable parser inputs (notably tool payloads).
  return structuredClone(assertMigrationBundle(bundle));
}
