import { hashCanonicalJson } from "../ir/canonical.js";
import type { JsonValue } from "../ir/types.js";
import { isRecord } from "../target/opencode/contract.js";
import type { OpenCodeSession } from "../target/opencode/mapping.js";
import type { ManifestSession, MigrationManifest } from "./manifest.js";

export const jsonHash = (value: unknown) =>
  hashCanonicalJson(value as JsonValue);

export function isOwnedByRun(
  transfer: OpenCodeSession, manifest: Pick<MigrationManifest, "runId">,
  item: Pick<ManifestSession, "targetId" | "sourceId" | "attempts">,
): boolean {
  const metadata = transfer.info.metadata;
  const marker = isRecord(metadata) ? metadata.trae2opencode : undefined;
  // v1 and the current v2 format both use v8; older verified v2 manifests remain replaceable.
  const supportedMappingVersion = isRecord(marker) &&
    typeof marker.mappingVersion === "number" &&
    marker.mappingVersion >= 1 && marker.mappingVersion <= 8 &&
    Number.isInteger(marker.mappingVersion);
  return transfer.info.id === item.targetId && isRecord(marker) &&
    marker.migrationRunId === manifest.runId && marker.sourceSessionId === item.sourceId &&
    supportedMappingVersion && item.attempts > 0;
}
