import { hashCanonicalJson } from "../ir/canonical.js";
import type { JsonValue } from "../ir/types.js";
import { isRecord } from "../target/opencode/contract.js";
import type { OpenCodeSession } from "../target/opencode/mapping.js";
import type { ManifestSession, MigrationManifest } from "./manifest.js";

export const jsonHash = (value: unknown) =>
  hashCanonicalJson(JSON.parse(JSON.stringify(value)) as JsonValue);

export function isOwnedByRun(
  transfer: OpenCodeSession, manifest: Pick<MigrationManifest, "runId">,
  item: Pick<ManifestSession, "targetId" | "sourceId" | "attempts">,
): boolean {
  const metadata = transfer.info.metadata;
  const marker = isRecord(metadata) ? metadata.trae2opencode : undefined;
  // 1-7 are v2 transfers; 8 marks the v1 dialect, which stores provenance on the session.
  const supportedMappingVersion = isRecord(marker) &&
    typeof marker.mappingVersion === "number" &&
    marker.mappingVersion >= 1 && marker.mappingVersion <= 8 &&
    Number.isInteger(marker.mappingVersion);
  return transfer.info.id === item.targetId && isRecord(marker) &&
    marker.migrationRunId === manifest.runId && marker.sourceSessionId === item.sourceId &&
    supportedMappingVersion && item.attempts > 0;
}
