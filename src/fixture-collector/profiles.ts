import type { ProfileFeatures } from "./types";

export type StorageProfileId =
  | "trae-cn-workspace-v3"
  | "trae-cn-memento-v1"
  | "trae-cn-hybrid"
  | "unknown";

export function identifyStorageProfile(
  features: ProfileFeatures,
): StorageProfileId {
  const hasWorkspaceDatabase = features.keyTables.includes("ItemTable");

  if (hasWorkspaceDatabase && features.hasMementoStorage) {
    return "trae-cn-hybrid";
  }
  if (features.hasMementoStorage) {
    return "trae-cn-memento-v1";
  }
  if (hasWorkspaceDatabase) {
    return "trae-cn-workspace-v3";
  }
  return "unknown";
}
