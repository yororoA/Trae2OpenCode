import { hashCanonicalJson } from "../ir/canonical.js";
import type { JsonValue } from "../ir/types.js";
import { Trae2OpenCodeError } from "../shared/errors.js";
import { requireOpenCodeCapabilities } from "../target/opencode/capability-probe.js";
import { openCodeDialectForVersion, type OpenCodeDialect } from "../target/opencode/contract.js";
import type { OpenCodeSession } from "../target/opencode/mapping.js";
import {
  createNativeOpenCodeAdapter, type NativeOpenCodeAdapterOptions,
} from "../target/opencode/native-adapter.js";
import { createOpenCodeTransport } from "../target/opencode/transport.js";

export interface MigrationTargetDescriptor {
  endpointHash: string;
  binaryVersion: string;
  serverVersion: string;
  schemaHash: string;
  fingerprint: string;
}

export interface MigrationTarget {
  describe(): Promise<MigrationTargetDescriptor>;
  readSession(id: string): Promise<OpenCodeSession | null>;
  importSession(transfer: OpenCodeSession): Promise<OpenCodeSession>;
  listChildren?(id: string): Promise<string[]>;
  deleteSession?(id: string, expectedHash: string, exclusiveTarget: boolean): Promise<void>;
}

/** The descriptor is produced only after protocol and compatibility validation. */
export function descriptorDialect(descriptor: MigrationTargetDescriptor): OpenCodeDialect {
  const dialect = openCodeDialectForVersion(descriptor.binaryVersion);
  if (!dialect) throw new Trae2OpenCodeError("T2O_OPENCODE_VERSION_UNSUPPORTED");
  return dialect;
}

/** Endpoint + verified contract, not a claim of database identity or authentication. */
export function createMigrationTarget(options: NativeOpenCodeAdapterOptions): MigrationTarget {
  const transport = options.transport ?? createOpenCodeTransport(options);
  createOpenCodeTransport({ serverUrl: options.serverUrl });
  const endpointHash = hashCanonicalJson(new URL(options.serverUrl).origin);
  const adapter = createNativeOpenCodeAdapter({ ...options, transport });
  return {
    ...adapter,
    async describe() {
      const capabilities = await requireOpenCodeCapabilities(transport);
      const descriptor = {
        endpointHash, binaryVersion: capabilities.binaryVersion!,
        serverVersion: capabilities.serverVersion!, schemaHash: capabilities.schemaHash!,
      };
      return { ...descriptor, fingerprint: hashCanonicalJson(descriptor as JsonValue) };
    },
  };
}
