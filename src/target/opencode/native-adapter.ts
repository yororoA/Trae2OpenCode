import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonValue } from "../../ir/types.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  jsonByteLength,
  JsonSizeLimitError,
  writeJson,
} from "../../shared/json-stream.js";
import { MAX_OPENCODE_TRANSFER_BYTES } from "../../shared/limits.js";
import { assertNoCredentials } from "../../shared/sensitive.js";
import { requireOpenCodeCapabilities } from "./capability-probe.js";
import {
  assertOpenCodeTransferForProfile, EXPORT_ROUTE, isRecord,
} from "./contract.js";
import type { OpenCodeSession, OpenCodeTransfer } from "./mapping.js";
import {
  LEGACY_EXPORT_ROUTE, protocolRuleById,
  type OpenCodeProtocolRuleId, type OpenCodeSchemaProfile,
} from "./protocol-rules.js";
import { requireOpenCodeReconciliation } from "./reconciliation.js";
import { createOpenCodeDeletionAdapter } from "./deletion.js";
import { withTemporaryInput } from "./temporary-input.js";
import { createOpenCodeTransport, type OpenCodeTransport } from "./transport.js";
import { createOpenCodeV1Adapter } from "./v1/adapter.js";

export interface NativeOpenCodeAdapterOptions {
  serverUrl: string;
  binary?: string;
  password?: string;
  username?: string;
  env?: NodeJS.ProcessEnv;
  temporaryRoot?: string;
  /** Inject the complete transport for contract tests or an isolated server. */
  transport?: OpenCodeTransport;
}

function assertId(id: string): void {
  if (!/^ses_[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_INVALID");
  }
}

function transferFrom(
  value: unknown, expectedId: string,
  schemaProfile: Extract<OpenCodeSchemaProfile, "v2-transfer" | "v2-transfer-legacy">,
): OpenCodeTransfer {
  assertOpenCodeTransferForProfile(value, schemaProfile);
  const transfer = value as OpenCodeTransfer;
  if (transfer.info.id !== expectedId) throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
  return transfer;
}

/**
 * Native CLI only for v2, whose `session export`/`session import` subcommands drive the
 * server. The existing-session check is advisory: OpenCode's atomic 409 conflict remains
 * authoritative if another process imports the ID concurrently.
 *
 * OpenCode v1 keeps no such route or subcommand pair, so the v1 adapter reads and writes
 * through the executable's top-level `export`/`import` subcommands instead.
 */
export function createNativeOpenCodeAdapter(options: NativeOpenCodeAdapterOptions) {
  // Always validate the endpoint, including when transport is injected.
  const transport = options.transport ?? createOpenCodeTransport(options);
  createOpenCodeTransport({ serverUrl: options.serverUrl });
  const serverUrl = new URL(options.serverUrl).origin;
  const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());

  const v2ByRule = new Map<OpenCodeProtocolRuleId, {
    read(id: string): Promise<OpenCodeTransfer | null>;
    listChildren(id: string): Promise<string[]>;
    deleteSession(id: string, expectedHash: string, exclusiveTarget: boolean): Promise<void>;
    schemaProfile: Extract<OpenCodeSchemaProfile, "v2-transfer" | "v2-transfer-legacy">;
  }>();
  const v2For = (protocolRule: OpenCodeProtocolRuleId | null) => {
    if (protocolRule === null) throw new Trae2OpenCodeError("T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
    const cached = v2ByRule.get(protocolRule);
    if (cached) return cached;
    const rule = protocolRuleById(protocolRule);
    if (rule.adapterProfile !== "v2-session-transfer" &&
        rule.adapterProfile !== "v2-session-transfer-legacy") {
      throw new Trae2OpenCodeError("T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
    }
    const exportRoute = rule.adapterProfile === "v2-session-transfer-legacy"
      ? LEGACY_EXPORT_ROUTE : EXPORT_ROUTE;
    const schemaProfile = rule.schemaProfile as Extract<
      OpenCodeSchemaProfile, "v2-transfer" | "v2-transfer-legacy"
    >;
    const read = async (id: string): Promise<OpenCodeTransfer | null> => {
      assertId(id);
      const result = await transport.request(exportRoute.replace("{sessionID}", id));
      if (result.status === 404) return null;
      if (result.status !== 200 || !isRecord(result.body)) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
      }
      return transferFrom(result.body.data, id, schemaProfile);
    };
    const adapter = {
      read, schemaProfile,
      ...createOpenCodeDeletionAdapter(
        transport, options.serverUrl, read,
        rule.deletionProfile === "v2-legacy" ? "v2-legacy" : "v2-current",
      ),
    };
    v2ByRule.set(protocolRule, adapter);
    return adapter;
  };
  const v1 = {
    current: createOpenCodeV1Adapter({ transport, temporaryRoot }),
    legacy: createOpenCodeV1Adapter({
      transport, temporaryRoot, schemaProfile: "v1-session-legacy",
    }),
  };
  const v1For = (protocolRule: OpenCodeProtocolRuleId | null) => {
    if (protocolRule === null) throw new Trae2OpenCodeError("T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
    const rule = protocolRuleById(protocolRule);
    if (rule.adapterProfile !== "v1-cli-library") {
      throw new Trae2OpenCodeError("T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
    }
    return rule.schemaProfile === "v1-session-legacy" ? v1.legacy : v1.current;
  };

  const importV2 = async (
    value: OpenCodeSession, protocolRule: OpenCodeProtocolRuleId,
  ): Promise<OpenCodeTransfer> => {
    const v2 = v2For(protocolRule);
    assertNoCredentials(value);
    assertOpenCodeTransferForProfile(value, v2.schemaProfile);
    const transfer = value as OpenCodeTransfer;
    const id = transfer.info.id;
    assertId(id);
    const directory = transfer.info.location.directory;
    if (!path.isAbsolute(directory)) throw new Trae2OpenCodeError("T2O_OPENCODE_DIRECTORY_INVALID");
    const losesAssistant = transfer.messages.some((message) =>
      message.type === "assistant" && (!isRecord(message.time) || typeof message.time.completed !== "number"));
    if (losesAssistant) throw new Trae2OpenCodeError("T2O_OPENCODE_MAPPING_REJECTED");
    try {
      jsonByteLength(
        transfer as unknown as JsonValue,
        {},
        MAX_OPENCODE_TRANSFER_BYTES,
      );
    } catch (error) {
      if (!(error instanceof JsonSizeLimitError)) throw error;
      throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_TOO_LARGE");
    }
    try {
      if (!(await fs.stat(directory)).isDirectory()) throw new Error("Not a directory");
    } catch {
      throw new Trae2OpenCodeError("T2O_OPENCODE_DIRECTORY_INVALID");
    }
    if (await v2.read(id)) throw new Trae2OpenCodeError("T2O_OPENCODE_SESSION_CONFLICT");
    const parentId = transfer.info.parentID;
    if (typeof parentId === "string" && !await v2.read(parentId)) {
      throw new Trae2OpenCodeError("T2O_OPENCODE_PARENT_MISSING");
    }
    await withTemporaryInput(
      temporaryRoot,
      async (file) => {
        await writeJson(
          file,
          transfer as unknown as JsonValue,
          {},
          MAX_OPENCODE_TRANSFER_BYTES,
        );
      },
      (filename) =>
        transport.run(["session", "import", filename, "--server", serverUrl, "--directory", directory]),
    );
    const actual = await v2.read(id);
    if (!actual) throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
    requireOpenCodeReconciliation(transfer, actual);
    return actual;
  };

  return {
    async readSession(id: string): Promise<OpenCodeSession | null> {
      assertId(id);
      const capabilities = await requireOpenCodeCapabilities(transport);
      return capabilities.dialect === "v1"
        ? v1For(capabilities.protocolRule).read(id)
        : v2For(capabilities.protocolRule).read(id);
    },
    async exportSession(id: string): Promise<OpenCodeSession> {
      assertId(id);
      const capabilities = await requireOpenCodeCapabilities(transport);
      if (capabilities.dialect === "v1") {
        const session = await v1For(capabilities.protocolRule).read(id);
        if (!session) throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
        return session;
      }
      const output = await transport.run(["session", "export", id, "--server", serverUrl]);
      let value: unknown;
      try { value = JSON.parse(output); }
      catch { throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID"); }
      return transferFrom(
        value, id, v2For(capabilities.protocolRule).schemaProfile,
      );
    },
    async importSession(value: OpenCodeSession): Promise<OpenCodeSession> {
      assertNoCredentials(value);
      // Snapshot before the first await so caller mutation cannot alter checked data.
      const transfer = structuredClone(value);
      const capabilities = await requireOpenCodeCapabilities(transport);
      return capabilities.dialect === "v1"
        ? v1For(capabilities.protocolRule).importSession(transfer)
        : importV2(transfer, capabilities.protocolRule!);
    },
    async listChildren(id: string): Promise<string[]> {
      assertId(id);
      const capabilities = await requireOpenCodeCapabilities(transport);
      return capabilities.dialect === "v1"
        ? v1For(capabilities.protocolRule).listChildren(id)
        : v2For(capabilities.protocolRule).listChildren(id);
    },
    async deleteSession(id: string, expectedHash: string, exclusiveTarget: boolean): Promise<void> {
      assertId(id);
      const capabilities = await requireOpenCodeCapabilities(transport);
      return capabilities.dialect === "v1"
        ? v1For(capabilities.protocolRule).deleteSession(id, expectedHash, exclusiveTarget)
        : v2For(capabilities.protocolRule).deleteSession(id, expectedHash, exclusiveTarget);
    },
  };
}

export type NativeOpenCodeAdapter = ReturnType<typeof createNativeOpenCodeAdapter>;
