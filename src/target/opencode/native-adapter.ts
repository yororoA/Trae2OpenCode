import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import { assertNoCredentials } from "../../shared/sensitive.js";
import { requireOpenCodeCapabilities } from "./capability-probe.js";
import { assertOpenCodeTransfer, EXPORT_ROUTE, isRecord } from "./contract.js";
import type { OpenCodeTransfer } from "./mapping.js";
import { requireOpenCodeReconciliation } from "./reconciliation.js";
import { createOpenCodeTransport, type OpenCodeTransport } from "./transport.js";

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

function transferFrom(value: unknown, expectedId: string): OpenCodeTransfer {
  assertOpenCodeTransfer(value);
  const transfer = value as OpenCodeTransfer;
  if (transfer.info.id !== expectedId) throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
  return transfer;
}

/**
 * Native CLI only. The existing-session check is advisory: OpenCode's atomic 409
 * conflict remains authoritative if another process imports the ID concurrently.
 */
export function createNativeOpenCodeAdapter(options: NativeOpenCodeAdapterOptions) {
  // Always validate the endpoint, including when transport is injected.
  const transport = options.transport ?? createOpenCodeTransport(options);
  createOpenCodeTransport({ serverUrl: options.serverUrl });
  const serverUrl = new URL(options.serverUrl).origin;
  const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  const read = async (id: string): Promise<OpenCodeTransfer | null> => {
    assertId(id);
    const result = await transport.request(EXPORT_ROUTE.replace("{sessionID}", id));
    if (result.status === 404) return null;
    if (result.status !== 200 || !isRecord(result.body)) {
      throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
    }
    return transferFrom(result.body.data, id);
  };
  return {
    async readSession(id: string): Promise<OpenCodeTransfer | null> {
      assertId(id);
      await requireOpenCodeCapabilities(transport);
      return read(id);
    },
    async exportSession(id: string): Promise<OpenCodeTransfer> {
      assertId(id);
      await requireOpenCodeCapabilities(transport);
      const output = await transport.run(["session", "export", id, "--server", serverUrl]);
      let value: unknown;
      try { value = JSON.parse(output); }
      catch { throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID"); }
      return transferFrom(value, id);
    },
    async importSession(value: OpenCodeTransfer): Promise<OpenCodeTransfer> {
      assertNoCredentials(value);
      // Snapshot before the first await so caller mutation cannot alter checked data.
      const transfer = structuredClone(value);
      assertOpenCodeTransfer(transfer);
      const id = transfer.info.id;
      assertId(id);
      const directory = transfer.info.location.directory;
      if (!path.isAbsolute(directory)) throw new Trae2OpenCodeError("T2O_OPENCODE_DIRECTORY_INVALID");
      const losesAssistant = transfer.messages.some((message) =>
        message.type === "assistant" && (!isRecord(message.time) || typeof message.time.completed !== "number"));
      if (losesAssistant) throw new Trae2OpenCodeError("T2O_OPENCODE_MAPPING_REJECTED");
      const serialized = JSON.stringify(transfer);
      if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_TOO_LARGE");
      }
      try {
        if (!(await fs.stat(directory)).isDirectory()) throw new Error("Not a directory");
      } catch {
        throw new Trae2OpenCodeError("T2O_OPENCODE_DIRECTORY_INVALID");
      }
      await requireOpenCodeCapabilities(transport);
      if (await read(id)) throw new Trae2OpenCodeError("T2O_OPENCODE_SESSION_CONFLICT");
      const parentId = transfer.info.parentID;
      if (typeof parentId === "string" && !await read(parentId)) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_PARENT_MISSING");
      }
      let root: string | undefined;
      let actual: OpenCodeTransfer | null = null;
      let failure: Trae2OpenCodeError | undefined;
      try {
        await fs.mkdir(temporaryRoot, { recursive: true });
        root = await fs.mkdtemp(path.join(temporaryRoot, "t2o-import-"));
        await fs.chmod(root, 0o700);
        const input = path.join(root, "session.json");
        await fs.writeFile(input, serialized, { mode: 0o600, flag: "wx" });
        await transport.run(["session", "import", input, "--server", serverUrl, "--directory", directory]);
        actual = await read(id);
        if (!actual) throw new Trae2OpenCodeError("T2O_OPENCODE_READBACK_INVALID");
        requireOpenCodeReconciliation(transfer, actual);
      } catch (error) {
        failure = error instanceof Trae2OpenCodeError
          ? error : new Trae2OpenCodeError("T2O_OPENCODE_IMPORT_FAILED");
      }
      if (root) {
        try { await fs.rm(root, { recursive: true, force: true }); }
        catch {
          throw new Trae2OpenCodeError("T2O_OPENCODE_TEMP_CLEANUP_FAILED", { cause: failure });
        }
      }
      if (failure) throw failure;
      return actual!;
    },
  };
}

export type NativeOpenCodeAdapter = ReturnType<typeof createNativeOpenCodeAdapter>;
