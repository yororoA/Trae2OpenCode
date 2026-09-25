import { hashCanonicalJson } from "../ir/canonical.js";
import type { JsonValue } from "../ir/types.js";
import { isRecord } from "../target/opencode/contract.js";
import type { OpenCodeTransfer } from "../target/opencode/mapping.js";
import type { ManifestSession, MigrationManifest } from "./manifest.js";

export const jsonHash = (value: unknown) =>
  hashCanonicalJson(JSON.parse(JSON.stringify(value)) as JsonValue);

export function isOwnedByRun(
  transfer: OpenCodeTransfer, manifest: Pick<MigrationManifest, "runId">,
  item: Pick<ManifestSession, "targetId" | "sourceId" | "attempts">,
): boolean {
  const metadata = transfer.info.metadata;
  const marker = isRecord(metadata) ? metadata.trae2opencode : undefined;
  const supportedMappingVersion = isRecord(marker) &&
    (marker.mappingVersion === 1 || marker.mappingVersion === 2 ||
      marker.mappingVersion === 3 || marker.mappingVersion === 4 ||
      marker.mappingVersion === 5 || marker.mappingVersion === 6 ||
      marker.mappingVersion === 7 || marker.mappingVersion === 8);
  return transfer.info.id === item.targetId && isRecord(marker) &&
    marker.migrationRunId === manifest.runId && marker.sourceSessionId === item.sourceId &&
    supportedMappingVersion && item.attempts > 0;
}
