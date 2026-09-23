import { createHash } from "node:crypto";
import type { MigrationBundle, SessionIR } from "../../ir/types.js";
import { assertMigrationBundle } from "../../ir/validation.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";

export interface OpenCodeIdentity {
  sourceSessionId: string;
  sessionId: string;
  parentId?: string;
  messageIds: ReadonlyMap<string, string>;
}

function reject(): never {
  throw new Trae2OpenCodeError("T2O_OPENCODE_IDENTITY_INVALID");
}

function digest(parts: readonly string[]): string {
  // A length-safe tuple avoids ambiguous delimiters; content and timestamps never enter identity.
  return createHash("sha256").update(JSON.stringify(["trae2opencode-id-v1", ...parts])).digest("hex");
}

export function stableOpenCodeSessionId(sourceSessionId: string, namespace = "trae-cn"): string {
  if (!namespace || !sourceSessionId) reject();
  return `ses_t2o_${digest([namespace, "session", sourceSessionId])}`;
}

export function stableOpenCodeMessageId(
  sourceSessionId: string, sourceMessageId: string, namespace = "trae-cn",
): string {
  if (!namespace || !sourceSessionId || !sourceMessageId) reject();
  return `msg_t2o_${digest([namespace, "message", sourceSessionId, sourceMessageId])}`;
}

/** Iterative parent-first traversal remains safe for deep session trees. */
function parentFirst(sessions: SessionIR[]): SessionIR[] {
  const byId = new Map(sessions.map((session) => [session.sourceId, session]));
  if (byId.size !== sessions.length) reject();
  const sorted = [...byId.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const complete = new Set<string>();
  const result: SessionIR[] = [];
  for (const id of sorted) {
    const visiting = new Set<string>();
    const chain: SessionIR[] = [];
    let current: string | undefined = id;
    while (current !== undefined && !complete.has(current)) {
      if (visiting.has(current)) reject();
      const session = byId.get(current);
      if (!session) reject();
      visiting.add(current);
      chain.push(session);
      current = session.parentSourceId;
    }
    for (const session of chain.reverse()) {
      complete.add(session.sourceId);
      result.push(session);
    }
  }
  return result;
}

/**
 * Namespace is stable across exports and source updates. Persist explicit namespaces
 * in manifests; changing one deliberately creates a separate target identity domain.
 * The changing sourceFingerprint is evidence, not an identity key.
 */
export function createOpenCodeIdentityMap(
  value: MigrationBundle, namespace = "trae-cn",
): OpenCodeIdentity[] {
  const bundle = assertMigrationBundle(value);
  if (!namespace) reject();
  return parentFirst(bundle.sessions).map((session) => {
    const messageIds = new Map(session.events.map((event) => [
      event.sourceId, stableOpenCodeMessageId(session.sourceId, event.sourceId, namespace),
    ]));
    if (messageIds.size !== session.events.length) reject();
    return {
      sourceSessionId: session.sourceId,
      sessionId: stableOpenCodeSessionId(session.sourceId, namespace),
      ...(session.parentSourceId ? { parentId: stableOpenCodeSessionId(session.parentSourceId, namespace) } : {}),
      messageIds,
    };
  });
}
