import type { ParserProfileRef, ProfileVerification } from "../../ir/types.js";
import type { ErrorCode } from "../../shared/error-codes.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";

export const VERIFIED_TRAE_PRODUCT_VERSION = "3.3.104";
export const WORKSPACE_PROFILE = Object.freeze({ id: "trae-cn-workspace-v3", version: 1 });
export const RUNTIME_PROFILE = Object.freeze({ id: "trae-cn-runtime-v2", version: 1 });

export type TraeParserCapability =
  | "session-metadata"
  | "query-cache"
  | "resources"
  | "runtime-metadata"
  | "user-messages"
  | "assistant-messages"
  | "reasoning-plan"
  | "tool-calls";

export interface TraeParserProfile extends Readonly<ParserProfileRef> {
  readonly productVersion: string;
  readonly sourceKind: "workspace" | "runtime";
  readonly verification: ProfileVerification;
  readonly capabilities: readonly TraeParserCapability[];
}

export interface TraeProfileSelection {
  productVersion: string | null;
  profileId: string;
  profileVersion: number;
}

// A new product version or revision requires its own fixture-backed registration.
const PROFILES: readonly TraeParserProfile[] = Object.freeze([
  Object.freeze({
    ...WORKSPACE_PROFILE,
    productVersion: VERIFIED_TRAE_PRODUCT_VERSION,
    sourceKind: "workspace" as const,
    verification: "verified" as const,
    capabilities: Object.freeze(["session-metadata", "query-cache", "resources"] as const),
  }),
  Object.freeze({
    ...RUNTIME_PROFILE,
    productVersion: VERIFIED_TRAE_PRODUCT_VERSION,
    sourceKind: "runtime" as const,
    verification: "verified" as const,
    capabilities: Object.freeze([
      "runtime-metadata", "user-messages", "assistant-messages", "reasoning-plan", "tool-calls",
    ] as const),
  }),
  ...["trae-cn-memento-v1", "trae-cn-hybrid"].map((id): TraeParserProfile => Object.freeze({
    id,
    version: 1,
    productVersion: VERIFIED_TRAE_PRODUCT_VERSION,
    sourceKind: "workspace",
    verification: "unverified",
    capabilities: Object.freeze([]),
  })),
]);

export function listTraeParserProfiles(): readonly TraeParserProfile[] {
  return PROFILES;
}

export function resolveTraeParserProfile(selection: TraeProfileSelection): TraeParserProfile {
  const supportsProductVersion = PROFILES.some((profile) => profile.productVersion === selection.productVersion);
  if (!supportsProductVersion) {
    throw new Trae2OpenCodeError("T2O_TRAE_PROFILE_VERSION_UNSUPPORTED");
  }
  const profile = PROFILES.find((candidate) =>
    candidate.productVersion === selection.productVersion && candidate.id === selection.profileId);
  if (!profile) throw new Trae2OpenCodeError("T2O_TRAE_PROFILE_UNKNOWN");
  if (profile.version !== selection.profileVersion) {
    throw new Trae2OpenCodeError("T2O_TRAE_PROFILE_REVISION_UNSUPPORTED");
  }
  if (profile.verification !== "verified") {
    throw new Trae2OpenCodeError("T2O_TRAE_PROFILE_UNVERIFIED");
  }
  return profile;
}

export function assertTraeParserCapability(
  productVersion: string | null,
  profile: Readonly<ParserProfileRef>,
  capability: TraeParserCapability,
  versionErrorCode?: ErrorCode,
): TraeParserProfile {
  let resolved: TraeParserProfile;
  try {
    resolved = resolveTraeParserProfile({
      productVersion,
      profileId: profile.id,
      profileVersion: profile.version,
    });
  } catch (error) {
    const isUnsupportedVersion =
      error instanceof Trae2OpenCodeError && error.code === "T2O_TRAE_PROFILE_VERSION_UNSUPPORTED";
    if (isUnsupportedVersion && versionErrorCode) throw new Trae2OpenCodeError(versionErrorCode);
    throw error;
  }
  if (!resolved.capabilities.includes(capability)) {
    throw new Trae2OpenCodeError("T2O_TRAE_PROFILE_CAPABILITY_UNSUPPORTED");
  }
  return resolved;
}

export function identifyTraeWorkspaceProfile(
  productVersion: string | null,
  hasItemTable: boolean,
  hasMementoStorage: boolean,
): { id: "trae-cn-workspace-v3" | "trae-cn-memento-v1" | "trae-cn-hybrid" | "unknown"; verification: ProfileVerification } {
  const supportsProductVersion = PROFILES.some((profile) => profile.productVersion === productVersion);
  if (!supportsProductVersion) return { id: "unknown", verification: "unsupported" };
  if (hasMementoStorage) {
    return { id: hasItemTable ? "trae-cn-hybrid" : "trae-cn-memento-v1", verification: "unverified" };
  }
  return hasItemTable
    ? { id: WORKSPACE_PROFILE.id, verification: "verified" }
    : { id: "unknown", verification: "unsupported" };
}

export function hasVerifiedTraeRuntimeProfile(productVersion: string | null): boolean {
  return PROFILES.some((profile) =>
    profile.productVersion === productVersion &&
    profile.id === RUNTIME_PROFILE.id &&
    profile.version === RUNTIME_PROFILE.version &&
    profile.verification === "verified");
}
