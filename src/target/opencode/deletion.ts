import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonValue } from "../../ir/types.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import { requireOpenCodeCapabilities } from "./capability-probe.js";
import { isRecord } from "./contract.js";
import type { OpenCodeSession } from "./mapping.js";
import type { OpenCodeTransport } from "./transport.js";

// Captured from an isolated OpenCode 2.0.12 server on 2026-09-24.
const REMOVE_HASH = "sha256:bf2c3d9d2dcb643e2d31f1e4aeca0db9591d51c9444a7d0eee36263193802f14";
const LIST_HASH = "sha256:28b438923094c8b480126933ddb5e5a83d1aa5e5d474d722b4e2629b0c8de333";
const RESPONSE_HASH = "sha256:2db1f7104094ac63c9b1903c639c7754e1632228b78eb37d42aae73f1c22d1e3";
const validId = (id: unknown): id is string => typeof id === "string" && /^ses_[a-zA-Z0-9_-]+$/.test(id);
const matches = (value: unknown, hash: string) =>
  isRecord(value) && hashCanonicalJson(value as JsonValue) === hash;

export function assertDeletionContract(api: unknown): void {
  const paths = isRecord(api) && isRecord(api.paths) ? api.paths : {};
  const session = paths["/api/session/{sessionID}"];
  const list = paths["/api/session"];
  const schemas = isRecord(api) && isRecord(api.components) && isRecord(api.components.schemas)
    ? api.components.schemas : {};
  const supported = isRecord(session) && matches(session.delete, REMOVE_HASH) &&
    isRecord(list) && matches(list.get, LIST_HASH) && matches(schemas.SessionsResponse, RESPONSE_HASH);
  if (!supported) throw new Trae2OpenCodeError("T2O_OPENCODE_DELETE_UNSUPPORTED");
}

export function createOpenCodeDeletionAdapter(
  transport: OpenCodeTransport, serverUrl: string,
  read: (id: string) => Promise<OpenCodeSession | null>,
) {
  const requireContract = async () => {
    await requireOpenCodeCapabilities(transport);
    const response = await transport.request("/openapi.json");
    if (response.status !== 200) throw new Trae2OpenCodeError("T2O_OPENCODE_DELETE_UNSUPPORTED");
    assertDeletionContract(response.body);
  };
  const listChildren = async (id: string): Promise<string[]> => {
    if (!validId(id)) throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_INVALID");
    await requireContract();
    const children = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ parentID: id, limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const result = await transport.request(`/api/session?${query}`);
      const body = result.body;
      const validPage = result.status === 200 && isRecord(body) &&
        Array.isArray(body.data) && isRecord(body.cursor);
      if (!validPage) throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
      for (const child of body.data as unknown[]) {
        const validChild = isRecord(child) && validId(child.id) &&
          child.parentID === id && child.id !== id && !children.has(child.id);
        if (!validChild) throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
        children.add(child.id as string);
      }
      const next = (body.cursor as Record<string, unknown>).next;
      if (next !== null && (typeof next !== "string" || !next || next.length > 8192 || cursors.has(next))) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
      }
      cursor = typeof next === "string" ? next : undefined;
      if (cursor) cursors.add(cursor);
      if (children.size > 100_000 || cursors.size > 1000) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
      }
    } while (cursor);
    return [...children];
  };
  return {
    listChildren,
    async deleteSession(id: string, expectedHash: string, exclusiveTarget: boolean): Promise<void> {
      if (!exclusiveTarget) throw new Trae2OpenCodeError("T2O_MIGRATION_EXCLUSIVE_REQUIRED");
      // Native delete cascades. Every actual deletion must be a leaf, even after preflight.
      if ((await listChildren(id)).length) throw new Trae2OpenCodeError("T2O_MIGRATION_CHILDREN_PROTECTED");
      const current = await read(id);
      if (!current || hashCanonicalJson(current as unknown as JsonValue) !== expectedHash) {
        throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
      }
      // OpenCode has no conditional DELETE; exclusive target use is a caller precondition.
      await transport.run(["session", "delete", id, "--server", new URL(serverUrl).origin]);
      if (await read(id)) throw new Trae2OpenCodeError("T2O_OPENCODE_DELETE_FAILED");
    },
  };
}
