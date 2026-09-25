import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hashCanonicalJson } from "../../../ir/canonical.js";
import type { JsonValue } from "../../../ir/types.js";
import { Trae2OpenCodeError } from "../../../shared/errors.js";
import { assertNoCredentials } from "../../../shared/sensitive.js";
import { isRecord } from "../contract.js";
import type { OpenCodeSession } from "../mapping.js";
import { withTemporaryInput } from "../temporary-input.js";
import type { OpenCodeTransport } from "../transport.js";
import { assertOpenCodeV1Session, V1_SESSION_ROUTE, V1_SESSION_CHILDREN_ROUTE } from "./contract.js";
import type { OpenCodeV1Session } from "./mapping.js";
import { requireOpenCodeV1Reconciliation } from "./reconciliation.js";

const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^ses_[a-zA-Z0-9_-]+$/.test(value);

export interface OpenCodeV1AdapterOptions {
  transport: OpenCodeTransport;
  temporaryRoot: string;
}

function sessionFrom(value: unknown, expectedId: string): OpenCodeV1Session {
  assertOpenCodeV1Session(value);
  const session = value as OpenCodeV1Session;
  if (session.info.id !== expectedId) throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
  return session;
}

/**
 * OpenCode v1 has no session import/export route, so the transfer moves through the
 * executable's own `import`/`export` subcommands, which write the local session library.
 */
export function createOpenCodeV1Adapter(options: OpenCodeV1AdapterOptions) {
  const { transport, temporaryRoot } = options;
  const route = (template: string, id: string) => template.replace("{sessionID}", id);

  const exists = async (id: string): Promise<boolean> => {
    const result = await transport.request(route(V1_SESSION_ROUTE, id));
    if (result.status === 404) return false;
    if (result.status !== 200 || !isRecord(result.body) || result.body.id !== id) {
      throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
    }
    return true;
  };

  const read = async (id: string): Promise<OpenCodeV1Session | null> => {
    if (!validId(id)) throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_INVALID");
    if (!await exists(id)) return null;
    // `export` reads the stored session, so the process directory does not affect it.
    const output = await transport.run(["export", id]);
    let value: unknown;
    try {
      value = JSON.parse(output.replace(/^\uFEFF/, ""));
    } catch {
      throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
    }
    return sessionFrom(value, id);
  };

  const listChildren = async (id: string): Promise<string[]> => {
    if (!validId(id)) throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_INVALID");
    const result = await transport.request(route(V1_SESSION_CHILDREN_ROUTE, id));
    if (result.status !== 200 || !Array.isArray(result.body)) {
      throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
    }
    const children = new Set<string>();
    for (const child of result.body as unknown[]) {
      // v1 already narrows the response to children; the parent link is still re-checked.
      const valid = isRecord(child) && validId(child.id) &&
        child.parentID === id && child.id !== id && !children.has(child.id);
      if (!valid) throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
      children.add(child.id as string);
    }
    if (children.size > 100_000) throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
    return [...children];
  };

  return {
    read,
    listChildren,
    async importSession(value: OpenCodeSession): Promise<OpenCodeV1Session> {
      assertNoCredentials(value);
      // Snapshot before the first await so caller mutation cannot alter checked data.
      const session = structuredClone(value) as OpenCodeV1Session;
      assertOpenCodeV1Session(session);
      const id = session.info.id;
      if (!validId(id)) throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_INVALID");
      // v1 adopts the importing process working directory as the session directory.
      const directory = session.info.directory;
      if (typeof directory !== "string" || !path.isAbsolute(directory)) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_DIRECTORY_INVALID");
      }
      try {
        if (!(await fs.stat(directory)).isDirectory()) throw new Error("Not a directory");
      } catch {
        throw new Trae2OpenCodeError("T2O_OPENCODE_DIRECTORY_INVALID");
      }
      const serialized = JSON.stringify(session);
      if (Buffer.byteLength(serialized, "utf8") > MAX_TRANSFER_BYTES) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_TOO_LARGE");
      }
      if (await exists(id)) throw new Trae2OpenCodeError("T2O_OPENCODE_SESSION_CONFLICT");
      const parentID = session.info.parentID;
      if (typeof parentID === "string" && !await exists(parentID)) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_PARENT_MISSING");
      }
      await withTemporaryInput(temporaryRoot, serialized, (filename) =>
        transport.run(["import", filename], { cwd: directory }));
      const actual = await read(id);
      if (!actual) throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
      requireOpenCodeV1Reconciliation(session, actual);
      return actual;
    },
    async deleteSession(id: string, expectedHash: string, exclusiveTarget: boolean): Promise<void> {
      if (!exclusiveTarget) throw new Trae2OpenCodeError("T2O_MIGRATION_EXCLUSIVE_REQUIRED");
      // v1 deletes cascade, so every actual deletion must start from a leaf.
      if ((await listChildren(id)).length) {
        throw new Trae2OpenCodeError("T2O_MIGRATION_CHILDREN_PROTECTED");
      }
      const current = await read(id);
      if (!current || hashCanonicalJson(current as unknown as JsonValue) !== expectedHash) {
        throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
      }
      // v1 has no conditional DELETE; exclusive target use is a caller precondition.
      const result = await transport.request(route(V1_SESSION_ROUTE, id), { method: "DELETE" });
      if (result.status !== 200) throw new Trae2OpenCodeError("T2O_OPENCODE_DELETE_FAILED");
      if (await exists(id)) throw new Trae2OpenCodeError("T2O_OPENCODE_DELETE_FAILED");
    },
  };
}

export type OpenCodeV1Adapter = ReturnType<typeof createOpenCodeV1Adapter>;