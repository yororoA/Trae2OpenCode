import { Trae2OpenCodeError } from "../../shared/errors.js";
import { VERIFIED_TRAE_PRODUCT_VERSION } from "./profile-definitions.js";
import { isRuntimeObject, runtimeHash } from "./reasoning-plan.js";

export interface TraeRuntimeTransport {
  productVersion: string;
  workspaceStorageId?: string;
  invoke(method: "getSession" | "getMessages", params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface TraeRuntimeLimits {
  maxPages?: number;
  maxBytes?: number;
}

function invalid(): never {
  throw new Trae2OpenCodeError("T2O_TRAE_RUNTIME_READ_INVALID");
}

function dataFrom(value: unknown): Record<string, unknown> {
  if (!isRuntimeObject(value) || value.code !== 0 || !isRuntimeObject(value.data)) return invalid();
  return value.data;
}

/** Read local history only. Pagination failure discards the entire session read. */
export function createTraeRuntimeReader(transport: TraeRuntimeTransport, limits: TraeRuntimeLimits = {}) {
  if (transport.productVersion !== VERIFIED_TRAE_PRODUCT_VERSION) {
    throw new Trae2OpenCodeError("T2O_TRAE_PROFILE_VERSION_UNSUPPORTED");
  }
  const maxPages = limits.maxPages ?? 10_000;
  const maxBytes = limits.maxBytes ?? 32 * 1024 * 1024;
  if (![maxPages, maxBytes].every((value) => Number.isSafeInteger(value) && value > 0)) invalid();
  const assertId = (id: string) => {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(id)) invalid();
  };
  return {
    productVersion: transport.productVersion,
    async readMetadata(sourceSessionIds: readonly string[]): Promise<unknown[]> {
      const records: unknown[] = [];
      let failures = 0;
      for (const id of sourceSessionIds) {
        assertId(id);
        try {
          const data = dataFrom(await transport.invoke("getSession", { chat_session_id: id, env: "local" }));
          if (data.chat_session_id !== id) invalid();
          records.push(data);
        } catch {
          failures++;
        }
      }
      if (failures > 0 && records.length === 0) invalid();
      return records;
    },
    async readMessages(sourceSessionId: string) {
      assertId(sourceSessionId);
      const items: unknown[] = [];
      const ids = new Map<string, string>();
      const tokens = new Set<string>();
      let pageToken: string | undefined;
      let bytes = 0;
      for (let page = 0; page < maxPages; page++) {
        const result = await transport.invoke("getMessages", {
          chat_session_id: sourceSessionId, env: "local", page_size: 20,
          ...(pageToken ? { page_token: pageToken } : {}),
        });
        bytes += Buffer.byteLength(JSON.stringify(result) ?? "", "utf8");
        if (bytes > maxBytes) throw new Trae2OpenCodeError("T2O_TRAE_RUNTIME_LIMIT");
        const data = dataFrom(result);
        if (!Array.isArray(data.items)) invalid();
        for (const item of data.items) {
          const validIdentity = isRuntimeObject(item) && item.chat_session_id === sourceSessionId &&
            typeof item.message_id === "string" && item.message_id.length > 0;
          if (!validIdentity) invalid();
          const record = item as Record<string, unknown>;
          const id = record.message_id as string;
          const hash = runtimeHash(item);
          const previous = ids.get(id);
          if (previous !== undefined && previous !== hash) invalid();
          if (previous === undefined) {
            ids.set(id, hash);
            items.push(item);
          }
        }
        const next = data.next_page_token;
        if (next === undefined || next === null || next === "") {
          if (data.has_more === true) invalid();
          return { value: items, expectedMessageCount: items.length };
        }
        const validNext = typeof next === "string" && next.length <= 4096 &&
          !tokens.has(next) && data.items.length > 0 && data.has_more !== false;
        if (!validNext) invalid();
        tokens.add(next as string);
        pageToken = next as string;
      }
      throw new Trae2OpenCodeError("T2O_TRAE_RUNTIME_LIMIT");
    },
    close: () => transport.close(),
  };
}
