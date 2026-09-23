import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { JsonObject, JsonValue } from "../../ir/types.js";
import { ERROR_DEFINITIONS } from "../../shared/error-codes.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import type { DiscoveredTraeRoot } from "./path-discovery.js";
import { withReadonlySqliteSnapshot } from "./sqlite-snapshot.js";

export const VERIFIED_TRAE_USER_MESSAGE_VERSION = "3.3.104";

export type TraeUserMessageSourceKind =
  | "runtime-user-message"
  | "workspace-query-cache";

export type TraeUserMessageIssueCode =
  | "T2O_TRAE_USER_MESSAGE_CONTAINER_INVALID"
  | "T2O_TRAE_USER_MESSAGE_RECORD_INVALID"
  | "T2O_TRAE_USER_MESSAGE_CONTENT_INVALID"
  | "T2O_TRAE_USER_MESSAGE_QUERY_INVALID"
  | "T2O_TRAE_USER_MESSAGE_TEXT_MISSING"
  | "T2O_TRAE_USER_MESSAGE_TEXT_FROM_QUERY"
  | "T2O_TRAE_USER_MESSAGE_DUPLICATE_CONFLICT"
  | "T2O_TRAE_USER_MESSAGE_PROVIDER_FAILED"
  | "T2O_TRAE_QUERY_CACHE_CONTAINER_INVALID"
  | "T2O_TRAE_QUERY_CACHE_ENTRY_INVALID"
  | "T2O_TRAE_QUERY_CACHE_READ_FAILED";

export interface TraeUserMessageSource {
  kind: TraeUserMessageSourceKind;
  locator: string;
  sourceSessionId?: string;
  workspaceStorageId?: string;
  sha256: string;
}

export interface TraeUserMessageFieldSource {
  locator: string;
  sha256: string;
}

export interface TraeUserMessage {
  sourceMessageId: string;
  sourceSessionId: string;
  order: number;
  createdAt: number;
  text: string;
  textSource: TraeUserMessageFieldSource;
  query?: JsonValue[];
  querySource?: TraeUserMessageFieldSource;
  sources: TraeUserMessageSource[];
}

export interface TraeQueryCacheMultimedia {
  resourceId: string;
  resourceType: string;
}

export interface TraeQueryCacheFile {
  id: string;
  name: string;
  sizeBytes: number;
  type: string;
  resourceUri: string;
  kind: string;
  uploadMode: string;
  width?: number;
  height?: number;
}

export interface TraeQueryCacheEntry {
  sha256: string;
  inputText: string;
  parsedQuery: JsonValue[];
  multiMedia: TraeQueryCacheMultimedia[];
  files: TraeQueryCacheFile[];
  sources: TraeUserMessageSource[];
}

export interface TraeUserMessageIssue {
  code: TraeUserMessageIssueCode;
  severity: "warning" | "error";
  message: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  workspaceStorageId?: string;
  entryIndex?: number;
  field?: "content" | "query";
}

export interface TraeUserMessageReport {
  reportVersion: 1;
  productVersion: string;
  messages: TraeUserMessage[];
  queryCacheEntries: TraeQueryCacheEntry[];
  sourceCounts: Record<TraeUserMessageSourceKind, number>;
  issues: TraeUserMessageIssue[];
}

export interface TraeRuntimeUserMessageRequest {
  sourceSessionId: string;
}

export type TraeRuntimeUserMessageProvider = (
  request: TraeRuntimeUserMessageRequest,
) => unknown | Promise<unknown>;

export interface ReadTraeUserMessagesOptions {
  root: DiscoveredTraeRoot;
  productVersion: string;
  sourceSessionIds: readonly string[];
  runtimeMessageProvider?: TraeRuntimeUserMessageProvider;
  temporaryRoot?: string;
}

interface ParseResult<Value> {
  valid: boolean;
  value?: Value;
}

interface QueryParseResult {
  valid: boolean;
  parts?: JsonValue[];
  source?: TraeUserMessageFieldSource;
}

interface ContentParseResult {
  valid: boolean;
  text?: string;
  source?: TraeUserMessageFieldSource;
}

const INPUT_HISTORY_KEY = "icube-ai-agent-storage-input-history";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const ISSUE_MESSAGES: Record<TraeUserMessageIssueCode, string> = {
  T2O_TRAE_USER_MESSAGE_CONTAINER_INVALID:
    "The TRAE runtime message container is invalid.",
  T2O_TRAE_USER_MESSAGE_RECORD_INVALID:
    "A TRAE runtime user message record is invalid.",
  T2O_TRAE_USER_MESSAGE_CONTENT_INVALID:
    "A TRAE runtime user message content field is invalid.",
  T2O_TRAE_USER_MESSAGE_QUERY_INVALID:
    "A TRAE runtime user message query field is invalid.",
  T2O_TRAE_USER_MESSAGE_TEXT_MISSING:
    "A TRAE runtime user message has no recoverable text.",
  T2O_TRAE_USER_MESSAGE_TEXT_FROM_QUERY:
    "TRAE user message text was recovered from parsed query data.",
  T2O_TRAE_USER_MESSAGE_DUPLICATE_CONFLICT:
    "Conflicting TRAE runtime user messages share an identifier.",
  T2O_TRAE_USER_MESSAGE_PROVIDER_FAILED:
    ERROR_DEFINITIONS.T2O_TRAE_USER_MESSAGE_PROVIDER_FAILED.message,
  T2O_TRAE_QUERY_CACHE_CONTAINER_INVALID:
    "The TRAE input history container is invalid.",
  T2O_TRAE_QUERY_CACHE_ENTRY_INVALID:
    "A TRAE input history entry is invalid.",
  T2O_TRAE_QUERY_CACHE_READ_FAILED:
    "A TRAE input history database could not be read.",
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
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : `"${value}"`;
  }
  if (
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalize(item)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function sha256(value: unknown): string {
  return `sha256:${crypto
    .createHash("sha256")
    .update(canonicalize(value))
    .digest("hex")}`;
}

function createIssue(
  code: TraeUserMessageIssueCode,
  options: Omit<TraeUserMessageIssue, "code" | "message">,
): TraeUserMessageIssue {
  return {
    code,
    message: ISSUE_MESSAGES[code],
    ...options,
  };
}

function assertSupportedVersion(productVersion: string): void {
  if (productVersion !== VERIFIED_TRAE_USER_MESSAGE_VERSION) {
    throw new Trae2OpenCodeError(
      "T2O_TRAE_USER_MESSAGE_VERSION_UNSUPPORTED",
    );
  }
}

function parseIdentifier(
  value: unknown,
  pattern = IDENTIFIER_PATTERN,
): string | undefined {
  return typeof value === "string" && pattern.test(value)
    ? value
    : undefined;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  const integer = parseNonNegativeInteger(value);
  if (integer !== undefined) return integer;
  if (typeof value !== "string") return undefined;

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): ParseResult<JsonValue> {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return { valid: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { valid: true, value }
      : { valid: false };
  }
  if (typeof value !== "object") return { valid: false };
  if (ancestors.has(value)) return { valid: false };

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    const normalized: JsonValue[] = [];
    for (const item of value) {
      const result = normalizeJsonValue(item, nextAncestors);
      if (!result.valid || result.value === undefined) {
        return { valid: false };
      }
      normalized.push(result.value);
    }
    return { valid: true, value: normalized };
  }

  const normalized: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const result = normalizeJsonValue(item, nextAncestors);
    if (!result.valid || result.value === undefined) {
      return { valid: false };
    }
    normalized[key] = result.value;
  }
  return { valid: true, value: normalized };
}

function normalizeQueryParts(value: unknown): ParseResult<JsonValue[]> {
  if (!Array.isArray(value)) return { valid: false };

  const parts: JsonValue[] = [];
  for (const part of value) {
    const isSupportedTopLevelPart =
      typeof part === "string" || isRecord(part);
    if (!isSupportedTopLevelPart) return { valid: false };

    const normalized = normalizeJsonValue(part);
    if (!normalized.valid || normalized.value === undefined) {
      return { valid: false };
    }
    parts.push(normalized.value);
  }
  return { valid: true, value: parts };
}

function isAbsentQueryValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function selectQueryValue(record: Record<string, unknown>): {
  locator: string;
  value: unknown;
} | null {
  if (!isAbsentQueryValue(record.query)) {
    return { locator: "query", value: record.query };
  }
  if (!isRecord(record.user_message_context)) return null;

  const context = record.user_message_context;
  if (!isAbsentQueryValue(context.parsed_query)) {
    return {
      locator: "user_message_context.parsed_query",
      value: context.parsed_query,
    };
  }
  if (!isAbsentQueryValue(context.parsedQuery)) {
    return {
      locator: "user_message_context.parsedQuery",
      value: context.parsedQuery,
    };
  }
  return null;
}

function parseQuery(record: Record<string, unknown>): QueryParseResult {
  const selected = selectQueryValue(record);
  if (!selected) return { valid: true };

  let value = selected.value;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { valid: false };
    }
  }

  const normalized = normalizeQueryParts(value);
  if (!normalized.valid || normalized.value === undefined) {
    return { valid: false };
  }
  return {
    valid: true,
    parts: normalized.value,
    source: {
      locator: selected.locator,
      sha256: sha256(selected.value),
    },
  };
}

function getTextBlockValue(
  block: Record<string, unknown>,
): ParseResult<string | undefined> {
  if (block.type !== "text") {
    return { valid: true };
  }

  const value =
    block.text_content ??
    block.text ??
    block.content;
  return typeof value === "string"
    ? { valid: true, value }
    : { valid: false };
}

function extractContentText(value: unknown): ParseResult<string> {
  if (typeof value === "string") {
    return { valid: true, value };
  }

  if (!Array.isArray(value)) return { valid: false };

  const chunks: string[] = [];
  for (const block of value) {
    if (!isRecord(block)) return { valid: false };
    const parsed = getTextBlockValue(block);
    if (!parsed.valid) return { valid: false };
    if (parsed.value !== undefined) chunks.push(parsed.value);
  }
  return { valid: true, value: chunks.join("") };
}

function parseContent(record: Record<string, unknown>): ContentParseResult {
  if (!Object.hasOwn(record, "content")) {
    return { valid: true };
  }

  const rawContent = record.content;
  let content = rawContent;
  if (typeof rawContent === "string") {
    try {
      content = JSON.parse(rawContent);
    } catch {
      content = rawContent;
    }
  }

  const parsed = extractContentText(content);
  if (!parsed.valid || parsed.value === undefined) {
    return { valid: false };
  }
  return {
    valid: true,
    text: parsed.value,
    source: {
      locator: "content",
      sha256: sha256(rawContent),
    },
  };
}

function queryText(parts: JsonValue[] | undefined): string | undefined {
  if (!parts) return undefined;

  const chunks: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      chunks.push(part);
      continue;
    }
    if (
      part === null ||
      typeof part !== "object" ||
      Array.isArray(part) ||
      part.type !== "text"
    ) {
      continue;
    }
    const value =
      part.text_content ??
      part.text ??
      part.content;
    if (typeof value === "string") chunks.push(value);
  }
  const text = chunks.join("");
  return text.trim().length > 0 ? text : undefined;
}

function getRuntimeRecords(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  if (Array.isArray(value.messages)) return value.messages;
  if (Array.isArray(value.items)) return value.items;
  if (!isRecord(value.data)) return null;
  if (Array.isArray(value.data.messages)) return value.data.messages;
  if (Array.isArray(value.data.items)) return value.data.items;
  if (!isRecord(value.data.data)) return null;
  if (Array.isArray(value.data.data.messages)) {
    return value.data.data.messages;
  }
  if (Array.isArray(value.data.data.items)) {
    return value.data.data.items;
  }
  return null;
}

function compareSources(
  left: TraeUserMessageSource,
  right: TraeUserMessageSource,
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    (left.sourceSessionId ?? "").localeCompare(
      right.sourceSessionId ?? "",
    ) ||
    (left.workspaceStorageId ?? "").localeCompare(
      right.workspaceStorageId ?? "",
    ) ||
    left.locator.localeCompare(right.locator) ||
    left.sha256.localeCompare(right.sha256)
  );
}

function deduplicateSources(
  sources: TraeUserMessageSource[],
): TraeUserMessageSource[] {
  return [
    ...new Map(
      sources.map((source) => [
        canonicalize(source),
        source,
      ]),
    ).values(),
  ].sort(compareSources);
}

function compareMessages(
  left: TraeUserMessage,
  right: TraeUserMessage,
): number {
  return (
    left.sourceSessionId.localeCompare(right.sourceSessionId) ||
    left.order - right.order ||
    left.createdAt - right.createdAt ||
    left.sourceMessageId.localeCompare(right.sourceMessageId)
  );
}

function mergeMessages(
  messages: TraeUserMessage[],
  issues: TraeUserMessageIssue[],
): TraeUserMessage[] {
  const accepted = new Map<string, TraeUserMessage>();
  const conflicted = new Set<string>();

  for (const message of messages) {
    const sourceMessageId = message.sourceMessageId;
    if (conflicted.has(sourceMessageId)) continue;

    const existing = accepted.get(sourceMessageId);
    if (!existing) {
      accepted.set(sourceMessageId, message);
      continue;
    }

    const existingHash = existing.sources[0]?.sha256;
    const messageHash = message.sources[0]?.sha256;
    if (existingHash === messageHash) {
      existing.sources = deduplicateSources([
        ...existing.sources,
        ...message.sources,
      ]);
      continue;
    }

    accepted.delete(sourceMessageId);
    conflicted.add(sourceMessageId);
    issues.push(
      createIssue("T2O_TRAE_USER_MESSAGE_DUPLICATE_CONFLICT", {
        severity: "error",
        sourceSessionId: existing.sourceSessionId,
        sourceMessageId,
      }),
    );
  }

  return [...accepted.values()].sort(compareMessages);
}

function parseRuntimeRecord(
  value: unknown,
  entryIndex: number,
  issues: TraeUserMessageIssue[],
): TraeUserMessage | null {
  if (!isRecord(value)) {
    issues.push(
      createIssue("T2O_TRAE_USER_MESSAGE_RECORD_INVALID", {
        severity: "error",
        entryIndex,
      }),
    );
    return null;
  }
  if (value.role === "assistant") return null;
  if (value.role !== "user") {
    issues.push(
      createIssue("T2O_TRAE_USER_MESSAGE_RECORD_INVALID", {
        severity: "error",
        entryIndex,
      }),
    );
    return null;
  }

  const sourceMessageId = parseIdentifier(value.message_id);
  const sourceSessionId = parseIdentifier(
    value.chat_session_id,
    SESSION_ID_PATTERN,
  );
  const order = parseNonNegativeInteger(value.message_index);
  const createdAt = parseTimestamp(value.created_at);
  const hasInvalidIdentity =
    sourceMessageId === undefined ||
    sourceSessionId === undefined ||
    order === undefined ||
    createdAt === undefined;
  if (hasInvalidIdentity) {
    issues.push(
      createIssue("T2O_TRAE_USER_MESSAGE_RECORD_INVALID", {
        severity: "error",
        entryIndex,
        ...(sourceMessageId ? { sourceMessageId } : {}),
        ...(sourceSessionId ? { sourceSessionId } : {}),
      }),
    );
    return null;
  }

  const content = parseContent(value);
  if (!content.valid) {
    issues.push(
      createIssue("T2O_TRAE_USER_MESSAGE_CONTENT_INVALID", {
        severity: "error",
        sourceSessionId,
        sourceMessageId,
        entryIndex,
        field: "content",
      }),
    );
  }

  const query = parseQuery(value);
  if (!query.valid) {
    issues.push(
      createIssue("T2O_TRAE_USER_MESSAGE_QUERY_INVALID", {
        severity: "error",
        sourceSessionId,
        sourceMessageId,
        entryIndex,
        field: "query",
      }),
    );
  }

  let text =
    content.valid &&
    content.text !== undefined &&
    content.text.trim().length > 0
      ? content.text
      : undefined;
  let textSource = text ? content.source : undefined;
  if (!text && query.valid) {
    text = queryText(query.parts);
    textSource = text ? query.source : undefined;
    if (text) {
      issues.push(
        createIssue("T2O_TRAE_USER_MESSAGE_TEXT_FROM_QUERY", {
          severity: "warning",
          sourceSessionId,
          sourceMessageId,
          entryIndex,
          field: "query",
        }),
      );
    }
  }

  if (!text || !textSource) {
    issues.push(
      createIssue("T2O_TRAE_USER_MESSAGE_TEXT_MISSING", {
        severity: "error",
        sourceSessionId,
        sourceMessageId,
        entryIndex,
      }),
    );
    return null;
  }

  return {
    sourceMessageId,
    sourceSessionId,
    order,
    createdAt,
    text,
    textSource,
    ...(query.valid && query.parts
      ? { query: query.parts }
      : {}),
    ...(query.valid && query.source
      ? { querySource: query.source }
      : {}),
    sources: [
      {
        kind: "runtime-user-message",
        locator: "runtime:getMessages#message",
        sourceSessionId,
        sha256: sha256(value),
      },
    ],
  };
}

export function parseTraeRuntimeUserMessages(
  value: unknown,
  productVersion: string,
): Pick<TraeUserMessageReport, "messages" | "issues"> {
  assertSupportedVersion(productVersion);
  const records = getRuntimeRecords(value);
  if (!records) {
    return {
      messages: [],
      issues: [
        createIssue("T2O_TRAE_USER_MESSAGE_CONTAINER_INVALID", {
          severity: "error",
        }),
      ],
    };
  }

  const issues: TraeUserMessageIssue[] = [];
  const messages = records.flatMap((record, entryIndex) => {
    const parsed = parseRuntimeRecord(record, entryIndex, issues);
    return parsed ? [parsed] : [];
  });
  return {
    messages: mergeMessages(messages, issues),
    issues,
  };
}

function parseMultimedia(
  value: unknown,
): ParseResult<TraeQueryCacheMultimedia[]> {
  if (!Array.isArray(value)) return { valid: false };

  const multiMedia: TraeQueryCacheMultimedia[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.resource_id !== "string" ||
      item.resource_id.length === 0 ||
      typeof item.resource_type !== "string" ||
      item.resource_type.length === 0
    ) {
      return { valid: false };
    }
    multiMedia.push({
      resourceId: item.resource_id,
      resourceType: item.resource_type,
    });
  }
  return { valid: true, value: multiMedia };
}

function parseOptionalDimension(value: unknown): number | undefined {
  const parsed = parseNonNegativeInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function parseFiles(value: unknown): ParseResult<TraeQueryCacheFile[]> {
  if (value === undefined) return { valid: true, value: [] };
  if (!Array.isArray(value)) return { valid: false };

  const files: TraeQueryCacheFile[] = [];
  for (const item of value) {
    if (!isRecord(item)) return { valid: false };

    const sizeBytes = parseNonNegativeInteger(item.size);
    const requiredStrings = [
      item.id,
      item.name,
      item.type,
      item.resourceUri,
      item.kind,
      item.uploadMode,
    ];
    const hasInvalidRequiredField =
      sizeBytes === undefined ||
      requiredStrings.some(
        (field) =>
          typeof field !== "string" || field.length === 0,
      );
    const width = parseOptionalDimension(item.width);
    const height = parseOptionalDimension(item.height);
    const hasInvalidDimension =
      (item.width !== undefined && width === undefined) ||
      (item.height !== undefined && height === undefined);
    if (hasInvalidRequiredField || hasInvalidDimension) {
      return { valid: false };
    }

    files.push({
      id: item.id as string,
      name: item.name as string,
      sizeBytes,
      type: item.type as string,
      resourceUri: item.resourceUri as string,
      kind: item.kind as string,
      uploadMode: item.uploadMode as string,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    });
  }
  return { valid: true, value: files };
}

function parseQueryCacheEntry(
  value: unknown,
  workspaceStorageId: string,
  entryIndex: number,
): TraeQueryCacheEntry | null {
  if (!isRecord(value) || typeof value.inputText !== "string") {
    return null;
  }

  const parsedQuery = normalizeQueryParts(value.parsedQuery);
  const multiMedia = parseMultimedia(value.multiMedia);
  const files = parseFiles(value.files);
  const hasInvalidStructure =
    !parsedQuery.valid ||
    parsedQuery.value === undefined ||
    !multiMedia.valid ||
    multiMedia.value === undefined ||
    !files.valid ||
    files.value === undefined;
  if (hasInvalidStructure) return null;

  const normalizedParsedQuery = parsedQuery.value as JsonValue[];
  const normalizedMultiMedia =
    multiMedia.value as TraeQueryCacheMultimedia[];
  const normalizedFiles = files.value as TraeQueryCacheFile[];
  const hasRecoverableData =
    value.inputText.trim().length > 0 ||
    normalizedParsedQuery.length > 0 ||
    normalizedMultiMedia.length > 0 ||
    normalizedFiles.length > 0;
  if (!hasRecoverableData) return null;

  const normalized = {
    inputText: value.inputText,
    parsedQuery: normalizedParsedQuery,
    multiMedia: normalizedMultiMedia,
    files: normalizedFiles,
  };
  return {
    sha256: sha256(normalized),
    ...normalized,
    sources: [
      {
        kind: "workspace-query-cache",
        locator: `ItemTable:${INPUT_HISTORY_KEY}[${entryIndex}]`,
        workspaceStorageId,
        sha256: sha256(value),
      },
    ],
  };
}

function compareQueryCacheEntries(
  left: TraeQueryCacheEntry,
  right: TraeQueryCacheEntry,
): number {
  return left.sha256.localeCompare(right.sha256);
}

function mergeQueryCacheEntries(
  entries: TraeQueryCacheEntry[],
): TraeQueryCacheEntry[] {
  const byHash = new Map<string, TraeQueryCacheEntry>();
  for (const entry of entries) {
    const existing = byHash.get(entry.sha256);
    if (existing) {
      existing.sources = deduplicateSources([
        ...existing.sources,
        ...entry.sources,
      ]);
    } else {
      byHash.set(entry.sha256, entry);
    }
  }
  return [...byHash.values()].sort(compareQueryCacheEntries);
}

export function parseTraeQueryCache(
  value: unknown,
  workspaceStorageId: string,
  productVersion: string,
): Pick<TraeUserMessageReport, "queryCacheEntries" | "issues"> {
  assertSupportedVersion(productVersion);
  if (!Array.isArray(value)) {
    return {
      queryCacheEntries: [],
      issues: [
        createIssue("T2O_TRAE_QUERY_CACHE_CONTAINER_INVALID", {
          severity: "error",
          workspaceStorageId,
        }),
      ],
    };
  }

  const entries: TraeQueryCacheEntry[] = [];
  const issues: TraeUserMessageIssue[] = [];
  for (const [entryIndex, item] of value.entries()) {
    const entry = parseQueryCacheEntry(
      item,
      workspaceStorageId,
      entryIndex,
    );
    if (entry) {
      entries.push(entry);
    } else {
      issues.push(
        createIssue("T2O_TRAE_QUERY_CACHE_ENTRY_INVALID", {
          severity: "error",
          workspaceStorageId,
          entryIndex,
        }),
      );
    }
  }
  return {
    queryCacheEntries: mergeQueryCacheEntries(entries),
    issues,
  };
}

function inspectQueryCacheSnapshot(
  databasePath: string,
  workspaceStorageId: string,
  productVersion: string,
): Pick<TraeUserMessageReport, "queryCacheEntries" | "issues"> {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma("query_only = ON");
    const table = database
      .prepare(
        "SELECT name FROM sqlite_schema " +
          "WHERE type = 'table' AND name = 'ItemTable'",
      )
      .get();
    if (!table) {
      return {
        queryCacheEntries: [],
        issues: [
          createIssue("T2O_TRAE_QUERY_CACHE_READ_FAILED", {
            severity: "error",
            workspaceStorageId,
          }),
        ],
      };
    }

    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get(INPUT_HISTORY_KEY) as { value: unknown } | undefined;
    if (!row) return { queryCacheEntries: [], issues: [] };

    const serialized = toText(row.value);
    if (serialized === null) {
      return {
        queryCacheEntries: [],
        issues: [
          createIssue("T2O_TRAE_QUERY_CACHE_CONTAINER_INVALID", {
            severity: "error",
            workspaceStorageId,
          }),
        ],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      parsed = null;
    }
    return parseTraeQueryCache(
      parsed,
      workspaceStorageId,
      productVersion,
    );
  } finally {
    database.close();
  }
}

async function readQueryCaches(
  options: ReadTraeUserMessagesOptions,
): Promise<
  Pick<TraeUserMessageReport, "queryCacheEntries" | "issues">
> {
  if (!safeIsDirectory(options.root.workspaceStoragePath)) {
    return { queryCacheEntries: [], issues: [] };
  }

  let workspaceStorageIds: string[];
  try {
    workspaceStorageIds = fs
      .readdirSync(options.root.workspaceStoragePath, {
        withFileTypes: true,
      })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return {
      queryCacheEntries: [],
      issues: [
        createIssue("T2O_TRAE_QUERY_CACHE_READ_FAILED", {
          severity: "error",
        }),
      ],
    };
  }

  const entries: TraeQueryCacheEntry[] = [];
  const issues: TraeUserMessageIssue[] = [];
  for (const workspaceStorageId of workspaceStorageIds) {
    const sourcePath = path.join(
      options.root.workspaceStoragePath,
      workspaceStorageId,
      "state.vscdb",
    );
    if (!safeIsFile(sourcePath)) continue;

    try {
      const report = await withReadonlySqliteSnapshot(
        sourcePath,
        (snapshot) =>
          inspectQueryCacheSnapshot(
            snapshot.databasePath,
            workspaceStorageId,
            options.productVersion,
          ),
        { temporaryRoot: options.temporaryRoot },
      );
      entries.push(...report.queryCacheEntries);
      issues.push(...report.issues);
    } catch {
      issues.push(
        createIssue("T2O_TRAE_QUERY_CACHE_READ_FAILED", {
          severity: "error",
          workspaceStorageId,
        }),
      );
    }
  }
  return {
    queryCacheEntries: mergeQueryCacheEntries(entries),
    issues,
  };
}

function sourceCounts(
  messages: TraeUserMessage[],
  queryCacheEntries: TraeQueryCacheEntry[],
): Record<TraeUserMessageSourceKind, number> {
  return {
    "runtime-user-message": messages.reduce(
      (count, message) => count + message.sources.length,
      0,
    ),
    "workspace-query-cache": queryCacheEntries.reduce(
      (count, entry) => count + entry.sources.length,
      0,
    ),
  };
}

export async function readTraeUserMessages(
  options: ReadTraeUserMessagesOptions,
): Promise<TraeUserMessageReport> {
  assertSupportedVersion(options.productVersion);
  const issues: TraeUserMessageIssue[] = [];
  const messages: TraeUserMessage[] = [];
  const sourceSessionIds = [
    ...new Set(
      options.sourceSessionIds.filter((sourceSessionId) => {
        const valid = SESSION_ID_PATTERN.test(sourceSessionId);
        if (!valid) {
          issues.push(
            createIssue("T2O_TRAE_USER_MESSAGE_RECORD_INVALID", {
              severity: "error",
            }),
          );
        }
        return valid;
      }),
    ),
  ].sort();

  if (options.runtimeMessageProvider) {
    for (const sourceSessionId of sourceSessionIds) {
      try {
        const value = await options.runtimeMessageProvider({
          sourceSessionId,
        });
        const parsed = parseTraeRuntimeUserMessages(
          value,
          options.productVersion,
        );
        messages.push(
          ...parsed.messages.filter((message) => {
            if (message.sourceSessionId === sourceSessionId) {
              return true;
            }
            issues.push(
              createIssue("T2O_TRAE_USER_MESSAGE_RECORD_INVALID", {
                severity: "error",
                sourceSessionId: message.sourceSessionId,
                sourceMessageId: message.sourceMessageId,
              }),
            );
            return false;
          }),
        );
        issues.push(...parsed.issues);
      } catch {
        issues.push(
          createIssue("T2O_TRAE_USER_MESSAGE_PROVIDER_FAILED", {
            severity: "error",
            sourceSessionId,
          }),
        );
      }
    }
  }

  const queryCache = await readQueryCaches(options);
  issues.push(...queryCache.issues);
  const mergedMessages = mergeMessages(messages, issues);
  return {
    reportVersion: 1,
    productVersion: options.productVersion,
    messages: mergedMessages,
    queryCacheEntries: queryCache.queryCacheEntries,
    sourceCounts: sourceCounts(
      mergedMessages,
      queryCache.queryCacheEntries,
    ),
    issues,
  };
}
