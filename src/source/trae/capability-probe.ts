import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { ERROR_DEFINITIONS } from "../../shared/error-codes.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import type { DiscoveredTraeRoot } from "./path-discovery.js";
import { withReadonlySqliteSnapshot } from "./sqlite-snapshot.js";
import {
  resolveTraeWorkspaces,
  type ResolvedTraeWorkspace,
  type WorkspaceResolutionIssue,
} from "./workspace-resolution.js";

export const VERIFIED_TRAE_CAPABILITY_VERSION = "3.3.104";

export type TraeStorageProfileId =
  | "trae-cn-workspace-v3"
  | "trae-cn-memento-v1"
  | "trae-cn-hybrid"
  | "unknown";

export type CapabilityVerification =
  | "verified"
  | "unverified"
  | "unsupported";

export type CapabilityStatus =
  | "available"
  | "missing"
  | "invalid"
  | "unverified"
  | "requires-runtime";

export type CapabilityEvidence =
  | "none"
  | "path-observed"
  | "schema-observed"
  | "shape-observed"
  | "runtime-readback";

export type WorkspaceCapabilityFieldId =
  | "workspace-metadata"
  | "project-path"
  | "workspace-state"
  | "active-session-id"
  | "session-index"
  | "input-history"
  | "agent-mode-map"
  | "long-text"
  | "paste-files";

export type RuntimeCapabilityFieldId =
  | "user-text"
  | "assistant-text"
  | "reasoning"
  | "tool-calls"
  | "message-relations"
  | "message-timing";

export interface CapabilityField<FieldId extends string = string> {
  id: FieldId;
  status: CapabilityStatus;
  evidence: CapabilityEvidence;
}

export interface WorkspaceStorageProfile {
  id: TraeStorageProfileId;
  verification: CapabilityVerification;
}

export interface WorkspaceCapability {
  workspaceStorageId: string;
  locationKind: "folder" | "workspace";
  profile: WorkspaceStorageProfile;
  fields: Array<CapabilityField<WorkspaceCapabilityFieldId>>;
}

export interface CapabilityCount {
  available: number;
  missing: number;
  invalid: number;
  unverified: number;
  requiresRuntime: number;
}

export interface CapabilityProbeIssue {
  code: `T2O_${string}`;
  severity: "warning" | "error";
  message: string;
  workspaceStorageId?: string;
  entryIndex?: number;
}

export interface RuntimeCapability {
  profileId: "trae-cn-runtime-v2" | "unknown";
  verification: CapabilityVerification;
  adapterStatus: "available" | "unavailable" | "error";
  fields: Array<CapabilityField<RuntimeCapabilityFieldId>>;
}

export interface TraeCapabilityReport {
  reportVersion: 1;
  productVersion: string | null;
  discoveredWorkspaceCount: number;
  resolvedWorkspaceCount: number;
  workspaces: WorkspaceCapability[];
  runtime: RuntimeCapability;
  coverage: Record<WorkspaceCapabilityFieldId, CapabilityCount>;
  profileCounts: Record<TraeStorageProfileId, number>;
  issues: CapabilityProbeIssue[];
}

export interface TraeCapabilityProbeOptions {
  root: DiscoveredTraeRoot;
  productVersion: string | null;
  runtimeProbe?: () => boolean | Promise<boolean>;
  temporaryRoot?: string;
}

type ObservedStatus = "available" | "missing" | "invalid";
type ValueShape =
  | "non-empty-string"
  | "array"
  | "object"
  | "session-index";

interface StateInspection {
  hasItemTable: boolean;
  status: ObservedStatus;
  fields: Record<
    | "active-session-id"
    | "session-index"
    | "input-history"
    | "agent-mode-map",
    ObservedStatus
  >;
  issue?: CapabilityProbeIssue;
}

const WORKSPACE_FIELD_IDS: WorkspaceCapabilityFieldId[] = [
  "workspace-metadata",
  "project-path",
  "workspace-state",
  "active-session-id",
  "session-index",
  "input-history",
  "agent-mode-map",
  "long-text",
  "paste-files",
];

const RUNTIME_FIELD_IDS: RuntimeCapabilityFieldId[] = [
  "user-text",
  "assistant-text",
  "reasoning",
  "tool-calls",
  "message-relations",
  "message-timing",
];

const STATE_FIELD_SPECS = [
  {
    id: "active-session-id",
    key: "ai-chat-v2.lastActiveSessionId",
    shape: "non-empty-string",
  },
  {
    id: "session-index",
    key: "chat.ChatSessionStore.index",
    shape: "session-index",
  },
  {
    id: "input-history",
    key: "icube-ai-agent-storage-input-history",
    shape: "array",
  },
  {
    id: "agent-mode-map",
    key: "songzhilin.irabo_AI.agent.modeListMap",
    shape: "object",
  },
] as const satisfies ReadonlyArray<{
  id: keyof StateInspection["fields"];
  key: string;
  shape: ValueShape;
}>;

function safeIsDirectory(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

function emptyStateFields(
  status: ObservedStatus,
): StateInspection["fields"] {
  return {
    "active-session-id": status,
    "session-index": status,
    "input-history": status,
    "agent-mode-map": status,
  };
}

function toText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
}

function hasExpectedShape(value: unknown, shape: ValueShape): boolean {
  const serialized = toText(value);
  if (serialized === null) return false;
  if (shape === "non-empty-string") return serialized.length > 0;

  try {
    const parsed = JSON.parse(serialized);
    if (shape === "array") return Array.isArray(parsed);
    const isObject =
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed);
    if (!isObject) return false;
    if (shape === "session-index") {
      const entries = (parsed as Record<string, unknown>).entries;
      return (
        entries !== null &&
        typeof entries === "object" &&
        !Array.isArray(entries)
      );
    }
    return true;
  } catch {
    return false;
  }
}

function inspectStateSnapshot(databasePath: string): StateInspection {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma("query_only = ON");
    const itemTable = database
      .prepare(
        "SELECT name FROM sqlite_schema " +
          "WHERE type = 'table' AND name = 'ItemTable'",
      )
      .get();
    if (!itemTable) {
      return {
        hasItemTable: false,
        status: "invalid",
        fields: emptyStateFields("invalid"),
      };
    }

    const columns = database
      .prepare("PRAGMA table_info('ItemTable')")
      .all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const hasExpectedColumns =
      columnNames.has("key") && columnNames.has("value");
    if (!hasExpectedColumns) {
      return {
        hasItemTable: false,
        status: "invalid",
        fields: emptyStateFields("invalid"),
      };
    }

    const selectValue = database.prepare(
      "SELECT value FROM ItemTable WHERE key = ?",
    );
    const fields = emptyStateFields("missing");
    for (const spec of STATE_FIELD_SPECS) {
      const row = selectValue.get(spec.key) as
        | { value: unknown }
        | undefined;
      fields[spec.id] =
        row === undefined
          ? "missing"
          : hasExpectedShape(row.value, spec.shape)
            ? "available"
            : "invalid";
    }

    return {
      hasItemTable: true,
      status: "available",
      fields,
    };
  } finally {
    database.close();
  }
}

function safeErrorCode(error: unknown): `T2O_${string}` {
  return error instanceof Trae2OpenCodeError
    ? error.code
    : "T2O_TRAE_SQLITE_SNAPSHOT_FAILED";
}

async function inspectWorkspaceState(
  workspace: ResolvedTraeWorkspace,
  temporaryRoot?: string,
): Promise<StateInspection> {
  const databasePath = path.join(
    workspace.workspaceStoragePath,
    "state.vscdb",
  );
  if (!safeIsFile(databasePath)) {
    return {
      hasItemTable: false,
      status: "missing",
      fields: emptyStateFields("missing"),
    };
  }

  try {
    return await withReadonlySqliteSnapshot(
      databasePath,
      (snapshot) => inspectStateSnapshot(snapshot.databasePath),
      { temporaryRoot },
    );
  } catch (error) {
    const code = safeErrorCode(error);
    return {
      hasItemTable: false,
      status: "invalid",
      fields: emptyStateFields("invalid"),
      issue: {
        code,
        severity: "error",
        message:
          error instanceof Trae2OpenCodeError
            ? error.message
            : ERROR_DEFINITIONS.T2O_TRAE_SQLITE_SNAPSHOT_FAILED.message,
        workspaceStorageId: workspace.workspaceStorageId,
      },
    };
  }
}

function identifyProfile(
  productVersion: string | null,
  hasItemTable: boolean,
  hasMementoStorage: boolean,
): WorkspaceStorageProfile {
  if (productVersion !== VERIFIED_TRAE_CAPABILITY_VERSION) {
    return {
      id: "unknown",
      verification: "unsupported",
    };
  }
  if (hasItemTable && hasMementoStorage) {
    return {
      id: "trae-cn-hybrid",
      verification: "unverified",
    };
  }
  if (hasMementoStorage) {
    return {
      id: "trae-cn-memento-v1",
      verification: "unverified",
    };
  }
  if (hasItemTable) {
    return {
      id: "trae-cn-workspace-v3",
      verification: "verified",
    };
  }
  return {
    id: "unknown",
    verification: "unsupported",
  };
}

function applyProfileGate(
  status: ObservedStatus,
  profile: WorkspaceStorageProfile,
): CapabilityStatus {
  if (status !== "available") return status;
  return profile.verification === "verified"
    ? "available"
    : "unverified";
}

function createWorkspaceFields(
  workspace: ResolvedTraeWorkspace,
  state: StateInspection,
  profile: WorkspaceStorageProfile,
): Array<CapabilityField<WorkspaceCapabilityFieldId>> {
  const observed: Record<
    WorkspaceCapabilityFieldId,
    {
      status: ObservedStatus;
      evidence: CapabilityEvidence;
    }
  > = {
    "workspace-metadata": {
      status: "available",
      evidence: "path-observed",
    },
    "project-path": {
      status:
        workspace.projects.length > 0 ? "available" : "missing",
      evidence: "path-observed",
    },
    "workspace-state": {
      status: state.status,
      evidence:
        state.status === "missing" ? "none" : "schema-observed",
    },
    "active-session-id": {
      status: state.fields["active-session-id"],
      evidence: "shape-observed",
    },
    "session-index": {
      status: state.fields["session-index"],
      evidence: "shape-observed",
    },
    "input-history": {
      status: state.fields["input-history"],
      evidence: "shape-observed",
    },
    "agent-mode-map": {
      status: state.fields["agent-mode-map"],
      evidence: "shape-observed",
    },
    "long-text": {
      status: safeIsDirectory(
        path.join(workspace.workspaceStoragePath, "long-text"),
      )
        ? "available"
        : "missing",
      evidence: "path-observed",
    },
    "paste-files": {
      status: safeIsDirectory(
        path.join(workspace.workspaceStoragePath, "paste-files"),
      )
        ? "available"
        : "missing",
      evidence: "path-observed",
    },
  };

  return WORKSPACE_FIELD_IDS.map((id) => ({
    id,
    status: applyProfileGate(observed[id].status, profile),
    evidence: observed[id].evidence,
  }));
}

function convertWorkspaceIssue(
  issue: WorkspaceResolutionIssue,
): CapabilityProbeIssue {
  return {
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    workspaceStorageId: issue.workspaceStorageId,
    ...(issue.entryIndex === undefined
      ? {}
      : { entryIndex: issue.entryIndex }),
  };
}

async function probeRuntimeCapability(
  productVersion: string | null,
  runtimeProbe: TraeCapabilityProbeOptions["runtimeProbe"],
): Promise<{
  capability: RuntimeCapability;
  issue?: CapabilityProbeIssue;
}> {
  const isVerifiedVersion =
    productVersion === VERIFIED_TRAE_CAPABILITY_VERSION;
  if (!isVerifiedVersion) {
    return {
      capability: {
        profileId: "unknown",
        verification: "unsupported",
        adapterStatus: "unavailable",
        fields: RUNTIME_FIELD_IDS.map((id) => ({
          id,
          status: "unverified",
          evidence: "none",
        })),
      },
    };
  }

  let adapterStatus: RuntimeCapability["adapterStatus"] = "unavailable";
  let issue: CapabilityProbeIssue | undefined;
  if (runtimeProbe) {
    try {
      adapterStatus = (await runtimeProbe())
        ? "available"
        : "unavailable";
    } catch {
      adapterStatus = "error";
      issue = {
        code: "T2O_TRAE_RUNTIME_PROBE_FAILED",
        severity: "error",
        message: ERROR_DEFINITIONS.T2O_TRAE_RUNTIME_PROBE_FAILED.message,
      };
    }
  }

  return {
    capability: {
      profileId: "trae-cn-runtime-v2",
      verification: "verified",
      adapterStatus,
      fields: RUNTIME_FIELD_IDS.map((id) => ({
        id,
        status:
          adapterStatus === "available"
            ? "available"
            : "requires-runtime",
        evidence: "runtime-readback",
      })),
    },
    ...(issue ? { issue } : {}),
  };
}

function createEmptyCapabilityCount(): CapabilityCount {
  return {
    available: 0,
    missing: 0,
    invalid: 0,
    unverified: 0,
    requiresRuntime: 0,
  };
}

function summarizeCoverage(
  workspaces: WorkspaceCapability[],
): Record<WorkspaceCapabilityFieldId, CapabilityCount> {
  const coverage = Object.fromEntries(
    WORKSPACE_FIELD_IDS.map((id) => [
      id,
      createEmptyCapabilityCount(),
    ]),
  ) as Record<WorkspaceCapabilityFieldId, CapabilityCount>;

  for (const workspace of workspaces) {
    for (const field of workspace.fields) {
      const count = coverage[field.id];
      if (field.status === "requires-runtime") {
        count.requiresRuntime += 1;
      } else {
        count[field.status] += 1;
      }
    }
  }
  return coverage;
}

function summarizeProfiles(
  workspaces: WorkspaceCapability[],
): Record<TraeStorageProfileId, number> {
  const counts: Record<TraeStorageProfileId, number> = {
    "trae-cn-workspace-v3": 0,
    "trae-cn-memento-v1": 0,
    "trae-cn-hybrid": 0,
    unknown: 0,
  };
  for (const workspace of workspaces) {
    counts[workspace.profile.id] += 1;
  }
  return counts;
}

export async function probeTraeCapabilities(
  options: TraeCapabilityProbeOptions,
): Promise<TraeCapabilityReport> {
  const workspaceResolution = resolveTraeWorkspaces({
    platform: options.root.platform,
    workspaceStoragePath: options.root.workspaceStoragePath,
  });
  const workspaces: WorkspaceCapability[] = [];
  const issues = workspaceResolution.issues.map(convertWorkspaceIssue);

  for (const workspace of workspaceResolution.workspaces) {
    const state = await inspectWorkspaceState(
      workspace,
      options.temporaryRoot,
    );
    const hasMementoStorage = safeIsDirectory(
      path.join(
        workspace.workspaceStoragePath,
        "memento",
        "icube-ai-agent-storage",
      ),
    );
    const profile = identifyProfile(
      options.productVersion,
      state.hasItemTable,
      hasMementoStorage,
    );
    workspaces.push({
      workspaceStorageId: workspace.workspaceStorageId,
      locationKind: workspace.location.kind,
      profile,
      fields: createWorkspaceFields(workspace, state, profile),
    });
    if (state.issue) issues.push(state.issue);
  }

  const runtime = await probeRuntimeCapability(
    options.productVersion,
    options.runtimeProbe,
  );
  if (runtime.issue) issues.push(runtime.issue);

  const discoveredWorkspaceIds = new Set([
    ...workspaceResolution.workspaces.map(
      (workspace) => workspace.workspaceStorageId,
    ),
    ...workspaceResolution.issues.map(
      (issue) => issue.workspaceStorageId,
    ),
  ]);

  return {
    reportVersion: 1,
    productVersion: options.productVersion,
    discoveredWorkspaceCount: discoveredWorkspaceIds.size,
    resolvedWorkspaceCount: workspaces.length,
    workspaces,
    runtime: runtime.capability,
    coverage: summarizeCoverage(workspaces),
    profileCounts: summarizeProfiles(workspaces),
    issues,
  };
}
