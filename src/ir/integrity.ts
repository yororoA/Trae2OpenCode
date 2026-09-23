import type { Diagnostic, JsonValue, MigrationBundle, SourceRef } from "./types.js";
import { hashCanonicalJson } from "./canonical.js";
import { assertMigrationBundle } from "./validation.js";

/** Schema validates shape; this pass validates identities and graph relationships. */
export function validateMigrationBundleIntegrity(value: unknown): Diagnostic[] {
  const bundle = assertMigrationBundle(value);
  const diagnostics: Diagnostic[] = [];
  const issue = (code: string, message: string, sourceId: string, sourceRefs: SourceRef[]) => {
    diagnostics.push({
      id: hashCanonicalJson({ code, sourceId, sourceRefs } as unknown as JsonValue),
      code, message, severity: "error", subject: { type: "session", sourceId }, sourceRefs,
    });
  };
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (!unique(bundle.projects.map((project) => project.sourceId))) {
    diagnostics.push({
      id: hashCanonicalJson("T2O_IR_PROJECT_ID_CONFLICT"),
      code: "T2O_IR_PROJECT_ID_CONFLICT", message: "IR project identifiers are not unique.",
      severity: "error", subject: { type: "bundle" }, sourceRefs: [],
    });
  }
  const sessions = new Map(bundle.sessions.map((session) => [session.sourceId, session]));
  const projects = new Set(bundle.projects.map((project) => project.sourceId));
  const parentCycles = findParentCycles(bundle);
  const seenSessions = new Set<string>();
  for (const session of bundle.sessions) {
    const report = (code: string, message: string) =>
      issue(code, message, session.sourceId, session.sourceRefs);
    if (seenSessions.has(session.sourceId)) report("T2O_IR_SESSION_ID_CONFLICT", "IR session identifiers are not unique.");
    seenSessions.add(session.sourceId);
    if (session.projectSourceId && !projects.has(session.projectSourceId)) {
      report("T2O_IR_PROJECT_REFERENCE_MISSING", "An IR session refers to an absent project.");
    }
    if (session.parentSourceId && !sessions.has(session.parentSourceId)) {
      report("T2O_IR_PARENT_REFERENCE_MISSING", "An IR session refers to an absent parent.");
    }
    if (parentCycles.has(session.sourceId)) report("T2O_IR_PARENT_CYCLE", "IR parent relationships contain a cycle.");
    const invalidSessionTime = session.createdAt !== undefined && session.updatedAt !== undefined &&
      session.updatedAt < session.createdAt;
    if (invalidSessionTime) report("T2O_IR_SESSION_TIME_INVALID", "IR session timestamps are inconsistent.");
    if (!unique(session.events.map((event) => event.sourceId))) {
      report("T2O_IR_EVENT_ID_CONFLICT", "IR event identifiers are not unique within a session.");
    }
    const events = new Map(session.events.map((event) => [event.sourceId, event]));
    let previousOrder = -1;
    for (const event of session.events) {
      const eventIssue = (code: string, message: string) =>
        issue(code, message, session.sourceId, event.sourceRefs);
      if (event.order <= previousOrder) {
        eventIssue("T2O_IR_EVENT_ORDER_CONFLICT", "IR events do not have a strictly increasing source order.");
      }
      previousOrder = event.order;
      const hasForeignSource = event.sourceRefs.some((ref) =>
        ref.sourceSessionId !== null && ref.sourceSessionId !== session.sourceId);
      if (hasForeignSource) eventIssue("T2O_IR_EVENT_SOURCE_MISMATCH", "An IR event source belongs to another session.");
      if (event.type !== "assistant") continue;
      const reply = event.replyToSourceId ? events.get(event.replyToSourceId) : undefined;
      const validReply = reply?.type === "user" && reply.order < event.order;
      if (!validReply) eventIssue("T2O_IR_REPLY_REFERENCE_INVALID", "An assistant event has no preceding user reply target.");
      const invalidCompletion = event.createdAt !== undefined && event.completedAt !== undefined &&
        event.completedAt < event.createdAt;
      if (invalidCompletion) eventIssue("T2O_IR_EVENT_TIME_INVALID", "IR assistant timestamps are inconsistent.");
      const callIds: string[] = [];
      for (const block of event.content) {
        if (block.type === "tool") callIds.push(block.callId);
        const invalidTime = block.createdAt !== undefined && block.completedAt !== undefined &&
          block.completedAt < block.createdAt;
        if (invalidTime) eventIssue("T2O_IR_CONTENT_TIME_INVALID", "IR content timestamps are inconsistent.");
        if (block.sourceRefs.some((ref) => ref.sourceSessionId !== null && ref.sourceSessionId !== session.sourceId)) {
          eventIssue("T2O_IR_CONTENT_SOURCE_MISMATCH", "An IR content source belongs to another session.");
        }
      }
      if (!unique(callIds)) eventIssue("T2O_IR_TOOL_ID_CONFLICT", "IR tool call identifiers are not unique within a message.");
    }
    if (!unique(session.resources.map((resource) => resource.sourceId))) {
      report("T2O_IR_RESOURCE_ID_CONFLICT", "IR resource identifiers are not unique within a session.");
    }
  }
  return [...new Map(diagnostics.map((diagnostic) => [diagnostic.id, diagnostic])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));
}

function findParentCycles(bundle: MigrationBundle): Set<string> {
  const parents = new Map(bundle.sessions.map((session) => [session.sourceId, session.parentSourceId]));
  const complete = new Set<string>();
  const cycles = new Set<string>();
  for (const session of bundle.sessions) {
    const positions = new Map<string, number>();
    const trail: string[] = [];
    let current: string | undefined = session.sourceId;
    while (current !== undefined && parents.has(current) && !complete.has(current)) {
      const position = positions.get(current);
      if (position !== undefined) {
        for (const id of trail.slice(position)) cycles.add(id);
        break;
      }
      positions.set(current, trail.length);
      trail.push(current);
      current = parents.get(current);
    }
    for (const id of trail) complete.add(id);
  }
  return cycles;
}
