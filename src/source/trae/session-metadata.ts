import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { ERROR_DEFINITIONS } from "../../shared/error-codes.js";
import type { DiscoveredTraeRoot } from "./path-discovery.js";
import { assertTraeParserCapability, RUNTIME_PROFILE, VERIFIED_TRAE_PRODUCT_VERSION, WORKSPACE_PROFILE } from "./profile-definitions.js";
import { withReadonlySqliteSnapshot } from "./sqlite-snapshot.js";

export const VERIFIED_TRAE_SESSION_METADATA_VERSION = VERIFIED_TRAE_PRODUCT_VERSION;

export type TraeSessionMetadataStatus =
  | "complete"
  | "partial"
  | "invalid";

export type TraeSessionMetadataSourceKind =
  | "runtime-metadata"
  | "snapshot-directory"
  | "workspace-active-session"
  | "workspace-session-index";

export type TraeSessionMetadataIssueCode =
  | "T2O_TRAE_SESSION_INDEX_RECORD_INVALID"
  | "T2O_TRAE_SESSION_TITLE_MISSING"
  | "T2O_TRAE_SESSION_CREATED_AT_MISSING"
  | "T2O_TRAE_SESSION_UPDATED_AT_MISSING"
  | "T2O_TRAE_SESSION_TIMESTAMP_INVALID"
  | "T2O_TRAE_SESSION_TIMESTAMP_ORDER_INVALID"
  | "T2O_TRAE_SESSION_METADATA_CONFLICT"
  | "T2O_TRAE_SESSION_METADATA_PROVIDER_FAILED";

export interface TraeSessionMetadataSource {
  kind: TraeSessionMetadataSourceKind;
  locator: string;
  workspaceStorageId?: string;
  sha256: string;
}

export interface TraeSessionMetadata {
  sourceSessionId: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  parentSourceId?: string;
  workspaceStorageIds: string[];
  metadataStatus: TraeSessionMetadataStatus;
  sources: TraeSessionMetadataSource[];
}

export interface TraeSessionMetadataIssue {
  code: TraeSessionMetadataIssueCode;
  severity: "warning" | "error";
  message: string;
  sourceSessionId?: string;
  workspaceStorageId?: string;
  entryIndex?: number;
  field?: "title" | "createdAt" | "updatedAt" | "parentSourceId";
}

export interface TraeSessionMetadataReport {
  reportVersion: 1;
  productVersion: string;
  sessions: TraeSessionMetadata[];
  sourceCounts: Record<TraeSessionMetadataSourceKind, number>;
  issues: TraeSessionMetadataIssue[];
}

export interface TraeRuntimeSessionMetadataRequest {
  sourceSessionIds: readonly string[];
}

export type TraeRuntimeSessionMetadataProvider = (
  request: TraeRuntimeSessionMetadataRequest,
) => unknown | Promise<unknown>;

export interface ReadTraeSessionMetadataOptions {
  root: DiscoveredTraeRoot;
  productVersion: string;
  runtimeMetadataProvider?: TraeRuntimeSessionMetadataProvider;
  runtimeSessionIds?: readonly string[];
  runtimeWorkspaceStorageId?: string;
  temporaryRoot?: string;
}

interface MetadataCandidate {
  sourceSessionId: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  parentSourceId?: string;
  priority: number;
  source: TraeSessionMetadataSource;
}

interface CandidateCollection {
  candidates: MetadataCandidate[];
  issues: TraeSessionMetadataIssue[];
}

const ACTIVE_SESSION_KEY = "ai-chat-v2.lastActiveSessionId";
const SESSION_INDEX_KEY = "chat.ChatSessionStore.index";
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const RUNTIME_BATCH_SIZE = 100;

const ISSUE_MESSAGES: Record<TraeSessionMetadataIssueCode, string> = {
  T2O_TRAE_SESSION_INDEX_RECORD_INVALID:
    "A TRAE session index record is invalid.",
  T2O_TRAE_SESSION_TITLE_MISSING:
    "The TRAE session title is missing.",
  T2O_TRAE_SESSION_CREATED_AT_MISSING:
    "The TRAE session creation time is missing.",
  T2O_TRAE_SESSION_UPDATED_AT_MISSING:
    "The TRAE session update time is missing.",
  T2O_TRAE_SESSION_TIMESTAMP_INVALID:
    "A TRAE session timestamp is invalid.",
  T2O_TRAE_SESSION_TIMESTAMP_ORDER_INVALID:
    "The TRAE session update time precedes its creation time.",
  T2O_TRAE_SESSION_METADATA_CONFLICT:
    "Conflicting TRAE session metadata was observed.",
  T2O_TRAE_SESSION_METADATA_PROVIDER_FAILED:
    ERROR_DEFINITIONS.T2O_TRAE_SESSION_METADATA_PROVIDER_FAILED.message,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

function toText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return `sha256:${crypto
    .createHash("sha256")
    .update(canonicalize(value))
    .digest("hex")}`;
}

function createIssue(
  code: TraeSessionMetadataIssueCode,
  options: Omit<TraeSessionMetadataIssue, "code" | "message"> = {
    severity: "warning",
  },
): TraeSessionMetadataIssue {
  return {
    code,
    message: ISSUE_MESSAGES[code],
    ...options,
  };
}

function assertSupportedVersion(productVersion: string): void {
  assertTraeParserCapability(productVersion, WORKSPACE_PROFILE, "session-metadata", "T2O_TRAE_SESSION_INDEX_VERSION_UNSUPPORTED");
}

function parseSessionId(value: unknown): string | undefined {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function parseTitle(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function parseMillisecondTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return value;
  }
  if (typeof value !== "string") return undefined;

  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseSecondTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
  ) {
    return undefined;
  }
  return parsed * 1_000;
}

function createSource(
  kind: TraeSessionMetadataSourceKind,
  locator: string,
  value: unknown,
  workspaceStorageId?: string,
): TraeSessionMetadataSource {
  return {
    kind,
    locator,
    ...(workspaceStorageId ? { workspaceStorageId } : {}),
    sha256: sha256(value),
  };
}

function getRuntimeRecords(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.sessions)) return value.sessions;
  if (isRecord(value.data)) {
    if (Array.isArray(value.data.items)) return value.data.items;
    if (Array.isArray(value.data.sessions)) return value.data.sessions;
    if (isRecord(value.data.data)) {
      if (Array.isArray(value.data.data.items)) {
        return value.data.data.items;
      }
      if (Array.isArray(value.data.data.sessions)) {
        return value.data.data.sessions;
      }
    }
  }
  return null;
}

function parseRuntimeCandidate(
  value: unknown,
  entryIndex: number,
): CandidateCollection {
  if (!isRecord(value)) {
    return {
      candidates: [],
      issues: [
        createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
          severity: "error",
          entryIndex,
        }),
      ],
    };
  }

  const hasModernSessionId = Object.hasOwn(value, "chat_session_id");
  const hasLocalSessionId = Object.hasOwn(value, "session_id");
  const modernSessionId = parseSessionId(value.chat_session_id);
  const localSessionId = parseSessionId(value.session_id);
  const hasInvalidSessionId =
    (hasModernSessionId && !modernSessionId) ||
    (hasLocalSessionId && !localSessionId);
  const hasConflictingSessionIds =
    modernSessionId !== undefined &&
    localSessionId !== undefined &&
    modernSessionId !== localSessionId;
  const sourceSessionId = modernSessionId ?? localSessionId;
  if (
    !sourceSessionId ||
    hasInvalidSessionId ||
    hasConflictingSessionIds
  ) {
    return {
      candidates: [],
      issues: [
        createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
          severity: "error",
          entryIndex,
        }),
      ],
    };
  }

  const isLocalListRecord =
    localSessionId !== undefined && modernSessionId === undefined;
  const createdAtValue = value.created_at;
  const updatedAtValue = isLocalListRecord
    ? value.update_at
    : value.updated_at;
  const parseTimestamp = isLocalListRecord
    ? parseSecondTimestamp
    : parseMillisecondTimestamp;
  const createdAt = parseTimestamp(createdAtValue);
  const updatedAt = parseTimestamp(updatedAtValue);
  const title = parseTitle(value.title) ?? parseTitle(value.name);
  const parentSourceId =
    value.parent_session_id === undefined ||
      value.parent_session_id === null ||
      value.parent_session_id === ""
      ? undefined
      : parseSessionId(value.parent_session_id);
  const issues: TraeSessionMetadataIssue[] = [];

  const hasInvalidTitle =
    (value.title !== undefined &&
      value.title !== null &&
      typeof value.title !== "string") ||
    (value.name !== undefined &&
      value.name !== null &&
      typeof value.name !== "string");
  if (hasInvalidTitle) {
    issues.push(
      createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
        severity: "error",
        sourceSessionId,
        entryIndex,
        field: "title",
      }),
    );
  }
  if (createdAtValue !== undefined && createdAt === undefined) {
    issues.push(
      createIssue("T2O_TRAE_SESSION_TIMESTAMP_INVALID", {
        severity: "error",
        sourceSessionId,
        entryIndex,
        field: "createdAt",
      }),
    );
  }
  if (updatedAtValue !== undefined && updatedAt === undefined) {
    issues.push(
      createIssue("T2O_TRAE_SESSION_TIMESTAMP_INVALID", {
        severity: "error",
        sourceSessionId,
        entryIndex,
        field: "updatedAt",
      }),
    );
  }
  const hasInvalidParent =
    value.parent_session_id !== undefined &&
    value.parent_session_id !== null &&
    value.parent_session_id !== "" &&
    parentSourceId === undefined;
  if (hasInvalidParent || parentSourceId === sourceSessionId) {
    issues.push(
      createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
        severity: "error",
        sourceSessionId,
        entryIndex,
        field: "parentSourceId",
      }),
    );
  }

  return {
    candidates: [
      {
        sourceSessionId,
        ...(title ? { title } : {}),
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(updatedAt === undefined ? {} : { updatedAt }),
        ...(parentSourceId && parentSourceId !== sourceSessionId
          ? { parentSourceId }
          : {}),
        priority: 2,
        source: createSource(
          "runtime-metadata",
          isLocalListRecord
            ? "TraeApi.chat.getSessions"
            : "TraeApi.chat.getSessionMetadata",
          value,
        ),
      },
    ],
    issues,
  };
}

function normalizeRuntimeCandidates(value: unknown): CandidateCollection {
  const records = getRuntimeRecords(value);
  if (!records) {
    return {
      candidates: [],
      issues: [
        createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
          severity: "error",
        }),
      ],
    };
  }

  return records.reduce<CandidateCollection>(
    (collection, record, entryIndex) => {
      const parsed = parseRuntimeCandidate(record, entryIndex);
      collection.candidates.push(...parsed.candidates);
      collection.issues.push(...parsed.issues);
      return collection;
    },
    { candidates: [], issues: [] },
  );
}

function selectField<Value extends string | number>(
  candidates: MetadataCandidate[],
  field: "title" | "createdAt" | "updatedAt" | "parentSourceId",
  sourceSessionId: string,
  issues: TraeSessionMetadataIssue[],
): Value | undefined {
  const populated = candidates.filter(
    (candidate) => candidate[field] !== undefined,
  );
  if (populated.length === 0) return undefined;

  const highestPriority = Math.max(
    ...populated.map((candidate) => candidate.priority),
  );
  const preferred = populated.filter(
    (candidate) => candidate.priority === highestPriority,
  );
  const values = new Set(
    preferred.map((candidate) => candidate[field] as Value),
  );
  if (values.size > 1) {
    issues.push(
      createIssue("T2O_TRAE_SESSION_METADATA_CONFLICT", {
        severity: "error",
        sourceSessionId,
        field,
      }),
    );
    return undefined;
  }
  return preferred[0][field] as Value;
}

function compareSources(
  left: TraeSessionMetadataSource,
  right: TraeSessionMetadataSource,
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    (left.workspaceStorageId ?? "").localeCompare(
      right.workspaceStorageId ?? "",
    ) ||
    left.sha256.localeCompare(right.sha256)
  );
}

function compareSessions(
  left: TraeSessionMetadata,
  right: TraeSessionMetadata,
): number {
  return (
    (right.updatedAt ?? -1) - (left.updatedAt ?? -1) ||
    (right.createdAt ?? -1) - (left.createdAt ?? -1) ||
    left.sourceSessionId.localeCompare(right.sourceSessionId)
  );
}

function buildSessions(
  candidates: MetadataCandidate[],
  issues: TraeSessionMetadataIssue[],
): TraeSessionMetadata[] {
  const bySession = new Map<string, MetadataCandidate[]>();
  for (const candidate of candidates) {
    const existing = bySession.get(candidate.sourceSessionId) ?? [];
    existing.push(candidate);
    bySession.set(candidate.sourceSessionId, existing);
  }

  const sessions: TraeSessionMetadata[] = [];
  for (const [sourceSessionId, sessionCandidates] of bySession) {
    const title = selectField<string>(
      sessionCandidates,
      "title",
      sourceSessionId,
      issues,
    );
    const createdAt = selectField<number>(
      sessionCandidates,
      "createdAt",
      sourceSessionId,
      issues,
    );
    const updatedAt = selectField<number>(
      sessionCandidates,
      "updatedAt",
      sourceSessionId,
      issues,
    );
    const parentSourceId = selectField<string>(
      sessionCandidates,
      "parentSourceId",
      sourceSessionId,
      issues,
    );

    if (!title) {
      issues.push(
        createIssue("T2O_TRAE_SESSION_TITLE_MISSING", {
          severity: "warning",
          sourceSessionId,
          field: "title",
        }),
      );
    }
    if (createdAt === undefined) {
      issues.push(
        createIssue("T2O_TRAE_SESSION_CREATED_AT_MISSING", {
          severity: "warning",
          sourceSessionId,
          field: "createdAt",
        }),
      );
    }
    if (updatedAt === undefined) {
      issues.push(
        createIssue("T2O_TRAE_SESSION_UPDATED_AT_MISSING", {
          severity: "warning",
          sourceSessionId,
          field: "updatedAt",
        }),
      );
    }
    if (
      createdAt !== undefined &&
      updatedAt !== undefined &&
      updatedAt < createdAt
    ) {
      issues.push(
        createIssue("T2O_TRAE_SESSION_TIMESTAMP_ORDER_INVALID", {
          severity: "error",
          sourceSessionId,
        }),
      );
    }

    const sources = [...new Map(
      sessionCandidates
        .map((candidate) => candidate.source)
        .map((source) => [
          JSON.stringify([
            source.kind,
            source.workspaceStorageId,
            source.sha256,
          ]),
          source,
        ]),
    ).values()].sort(compareSources);
    const workspaceStorageIds = [
      ...new Set(
        sources.flatMap((source) =>
          source.workspaceStorageId
            ? [source.workspaceStorageId]
            : [],
        ),
      ),
    ].sort();
    const sessionIssues = issues.filter(
      (issue) => issue.sourceSessionId === sourceSessionId,
    );
    const metadataStatus: TraeSessionMetadataStatus = sessionIssues.some(
      (issue) => issue.severity === "error",
    )
      ? "invalid"
      : sessionIssues.length > 0
        ? "partial"
        : "complete";

    sessions.push({
      sourceSessionId,
      ...(title ? { title } : {}),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(parentSourceId ? { parentSourceId } : {}),
      workspaceStorageIds,
      metadataStatus,
      sources,
    });
  }

  return sessions.sort(compareSessions);
}

export function parseTraeRuntimeSessionMetadata(
  value: unknown,
  productVersion: string,
): Pick<TraeSessionMetadataReport, "sessions" | "issues"> {
  assertTraeParserCapability(productVersion, RUNTIME_PROFILE, "runtime-metadata", "T2O_TRAE_SESSION_INDEX_VERSION_UNSUPPORTED");
  const collection = normalizeRuntimeCandidates(value);
  return {
    sessions: buildSessions(
      collection.candidates,
      collection.issues,
    ),
    issues: collection.issues,
  };
}

function inspectWorkspaceState(
  databasePath: string,
  workspaceStorageId: string,
): CandidateCollection {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  const candidates: MetadataCandidate[] = [];
  const issues: TraeSessionMetadataIssue[] = [];

  try {
    database.pragma("query_only = ON");
    const table = database
      .prepare(
        "SELECT name FROM sqlite_schema " +
          "WHERE type = 'table' AND name = 'ItemTable'",
      )
      .get();
    if (!table) {
      issues.push(
        createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
          severity: "error",
          workspaceStorageId,
        }),
      );
      return { candidates, issues };
    }

    const selectValue = database.prepare(
      "SELECT value FROM ItemTable WHERE key = ?",
    );
    const activeRow = selectValue.get(ACTIVE_SESSION_KEY) as
      | { value: unknown }
      | undefined;
    if (activeRow) {
      const rawSessionId = toText(activeRow.value);
      const sourceSessionId = parseSessionId(rawSessionId);
      if (sourceSessionId) {
        candidates.push({
          sourceSessionId,
          priority: 0,
          source: createSource(
            "workspace-active-session",
            `ItemTable:${ACTIVE_SESSION_KEY}`,
            rawSessionId,
            workspaceStorageId,
          ),
        });
      } else {
        issues.push(
          createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
            severity: "error",
            workspaceStorageId,
          }),
        );
      }
    }

    const indexRow = selectValue.get(SESSION_INDEX_KEY) as
      | { value: unknown }
      | undefined;
    if (!indexRow) return { candidates, issues };

    const serialized = toText(indexRow.value);
    let parsed: unknown;
    try {
      parsed = serialized ? JSON.parse(serialized) : null;
    } catch {
      parsed = null;
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !isRecord(parsed.entries)
    ) {
      issues.push(
        createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
          severity: "error",
          workspaceStorageId,
        }),
      );
      return { candidates, issues };
    }

    let entryIndex = 0;
    for (const [entryKey, entry] of Object.entries(parsed.entries).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const sourceSessionId = parseSessionId(entryKey);
      if (!sourceSessionId || !isRecord(entry)) {
        issues.push(
          createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
            severity: "error",
            workspaceStorageId,
            entryIndex,
          }),
        );
        entryIndex += 1;
        continue;
      }

      const embeddedSessionId = parseSessionId(entry.sessionId);
      const timing = isRecord(entry.timing) ? entry.timing : {};
      const createdAt = parseMillisecondTimestamp(timing.startTime);
      const updatedAt =
        parseMillisecondTimestamp(timing.endTime) ??
        parseMillisecondTimestamp(entry.lastMessageDate);
      const title = parseTitle(entry.title);
      if (
        embeddedSessionId !== sourceSessionId ||
        !title ||
        createdAt === undefined ||
        updatedAt === undefined
      ) {
        issues.push(
          createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
            severity: "error",
            sourceSessionId,
            workspaceStorageId,
            entryIndex,
          }),
        );
      }
      candidates.push({
        sourceSessionId,
        ...(title ? { title } : {}),
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(updatedAt === undefined ? {} : { updatedAt }),
        priority: 1,
        source: createSource(
          "workspace-session-index",
          `ItemTable:${SESSION_INDEX_KEY}`,
          entry,
          workspaceStorageId,
        ),
      });
      entryIndex += 1;
    }
  } finally {
    database.close();
  }

  return { candidates, issues };
}

async function collectWorkspaceCandidates(
  options: ReadTraeSessionMetadataOptions,
): Promise<CandidateCollection> {
  const candidates: MetadataCandidate[] = [];
  const issues: TraeSessionMetadataIssue[] = [];
  if (!safeIsDirectory(options.root.workspaceStoragePath)) {
    return { candidates, issues };
  }

  const workspaceStorageIds = fs
    .readdirSync(options.root.workspaceStoragePath, {
      withFileTypes: true,
    })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const workspaceStorageId of workspaceStorageIds) {
    const sourcePath = path.join(
      options.root.workspaceStoragePath,
      workspaceStorageId,
      "state.vscdb",
    );
    if (!safeIsFile(sourcePath)) continue;

    try {
      const collection = await withReadonlySqliteSnapshot(
        sourcePath,
        (snapshot) =>
          inspectWorkspaceState(
            snapshot.databasePath,
            workspaceStorageId,
          ),
        { temporaryRoot: options.temporaryRoot },
      );
      candidates.push(...collection.candidates);
      issues.push(...collection.issues);
    } catch {
      issues.push(
        createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
          severity: "error",
          workspaceStorageId,
        }),
      );
    }
  }

  return { candidates, issues };
}

function collectSnapshotCandidates(
  root: DiscoveredTraeRoot,
): CandidateCollection {
  const candidates: MetadataCandidate[] = [];
  const issues: TraeSessionMetadataIssue[] = [];
  const snapshotPath = path.join(
    root.modularDataPath,
    "ai-agent",
    "snapshot",
  );
  if (!safeIsDirectory(snapshotPath)) return { candidates, issues };

  const entries = fs
    .readdirSync(snapshotPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const [entryIndex, entry] of entries.entries()) {
    const sourceSessionId = parseSessionId(entry.name);
    if (!sourceSessionId) {
      issues.push(
        createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
          severity: "warning",
          entryIndex,
        }),
      );
      continue;
    }
    candidates.push({
      sourceSessionId,
      priority: 0,
      source: createSource(
        "snapshot-directory",
        "ModularData/ai-agent/snapshot/<session-id>",
        entry.name,
      ),
    });
  }
  return { candidates, issues };
}

function countSources(
  sessions: TraeSessionMetadata[],
): Record<TraeSessionMetadataSourceKind, number> {
  const counts: Record<TraeSessionMetadataSourceKind, number> = {
    "runtime-metadata": 0,
    "snapshot-directory": 0,
    "workspace-active-session": 0,
    "workspace-session-index": 0,
  };
  for (const session of sessions) {
    for (const source of session.sources) counts[source.kind] += 1;
  }
  return counts;
}

export async function readTraeSessionMetadata(
  options: ReadTraeSessionMetadataOptions,
): Promise<TraeSessionMetadataReport> {
  assertSupportedVersion(options.productVersion);
  const workspace = await collectWorkspaceCandidates(options);
  const snapshot = collectSnapshotCandidates(options.root);
  const candidates = [...workspace.candidates, ...snapshot.candidates];
  const issues = [...workspace.issues, ...snapshot.issues];
  const sourceSessionIds = [...new Set(
    options.runtimeSessionIds ??
      candidates.map((candidate) => candidate.sourceSessionId),
  )].sort();

  if (options.runtimeMetadataProvider) {
    for (
      let offset = 0;
      offset < sourceSessionIds.length;
      offset += RUNTIME_BATCH_SIZE
    ) {
      const batch = sourceSessionIds.slice(
        offset,
        offset + RUNTIME_BATCH_SIZE,
      );
      try {
        const value = await options.runtimeMetadataProvider({
          sourceSessionIds: batch,
        });
        const runtime = normalizeRuntimeCandidates(value);
        const requested = new Set(batch);
        const accepted = runtime.candidates.filter((candidate) => {
          if (requested.has(candidate.sourceSessionId)) return true;
          issues.push(
            createIssue("T2O_TRAE_SESSION_INDEX_RECORD_INVALID", {
              severity: "error",
              sourceSessionId: candidate.sourceSessionId,
            }),
          );
          return false;
        });
        candidates.push(...accepted.map((candidate) => ({
          ...candidate,
          source: {
            ...candidate.source,
            ...(options.runtimeWorkspaceStorageId
              ? { workspaceStorageId: options.runtimeWorkspaceStorageId }
              : {}),
          },
        })));
        issues.push(...runtime.issues);
      } catch {
        issues.push(
          createIssue("T2O_TRAE_SESSION_METADATA_PROVIDER_FAILED", {
            severity: "error",
          }),
        );
      }
    }
  }

  const sessions = buildSessions(candidates, issues);
  return {
    reportVersion: 1,
    productVersion: options.productVersion,
    sessions,
    sourceCounts: countSources(sessions),
    issues,
  };
}
