import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResourceRef } from "../../ir/types.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  scanTraeLongTextResources,
  type TraeAssistantMessageIssue,
} from "./assistant-messages.js";
import type { DiscoveredTraeRoot } from "./path-discovery.js";
import { isRuntimeObject, runtimeHash } from "./reasoning-plan.js";
import { assertResourcePath, inspectResourceFile } from "./resource-file.js";
import type { TraeQueryCacheEntry } from "./user-messages.js";

export interface TraeResourceSource {
  kind: "workspace-resource" | "query-cache-reference" | "explicit-reference";
  locator: string;
  sha256: string;
  workspaceStorageId: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
}

export interface TraeResource extends Omit<ResourceRef, "sourceRefs"> {
  workspaceStorageId: string;
  sources: TraeResourceSource[];
  references: TraeResourceSource[];
}

export interface TraeResourceReference {
  workspaceStorageId: string;
  path: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
}

export type TraeResourceIssueCode =
  | "T2O_TRAE_RESOURCE_SCAN_FAILED"
  | "T2O_TRAE_RESOURCE_LAYOUT_INVALID"
  | "T2O_TRAE_RESOURCE_READ_FAILED"
  | "T2O_TRAE_RESOURCE_REFERENCE_INVALID"
  | "T2O_TRAE_RESOURCE_MISSING"
  | "T2O_TRAE_RESOURCE_DEFERRED"
  | "T2O_TRAE_RESOURCE_MIME_UNKNOWN"
  | "T2O_TRAE_RESOURCE_METADATA_MISMATCH"
  | "T2O_TRAE_RESOURCE_UNASSOCIATED";

export interface TraeResourceIssue {
  code: TraeResourceIssueCode;
  severity: "warning" | "error";
  message: string;
  workspaceStorageId?: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  resourceId?: string;
  referenceSha256?: string;
}

export interface TraeResourceReport {
  resources: TraeResource[];
  issues: (TraeResourceIssue | TraeAssistantMessageIssue)[];
}

interface ReferenceCandidate {
  path?: string;
  declaredType?: ResourceRef["type"];
  mimeType?: string;
  sizeBytes?: number;
  source: TraeResourceSource;
}

const MESSAGES: Record<TraeResourceIssueCode, string> = {
  T2O_TRAE_RESOURCE_SCAN_FAILED: "A TRAE resource directory could not be scanned.",
  T2O_TRAE_RESOURCE_LAYOUT_INVALID: "A TRAE resource has an unsupported or unsafe layout.",
  T2O_TRAE_RESOURCE_READ_FAILED: "A TRAE resource could not be read consistently.",
  T2O_TRAE_RESOURCE_REFERENCE_INVALID: "A TRAE resource reference is invalid or outside its workspace.",
  T2O_TRAE_RESOURCE_MISSING: "A referenced TRAE resource is missing.",
  T2O_TRAE_RESOURCE_DEFERRED: "A TRAE resource reference has no verified local path.",
  T2O_TRAE_RESOURCE_MIME_UNKNOWN: "A TRAE resource MIME type could not be determined.",
  T2O_TRAE_RESOURCE_METADATA_MISMATCH: "TRAE resource bytes disagree with declared metadata.",
  T2O_TRAE_RESOURCE_UNASSOCIATED: "A TRAE resource has no explicit session association.",
};

function resourceId(workspaceStorageId: string, relativePath: string): string {
  return runtimeHash({ workspaceStorageId, relativePath });
}

function uniqueSources(sources: TraeResourceSource[]): TraeResourceSource[] {
  return [...new Map(sources.map((source) => [runtimeHash(source), source])).entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([, source]) => source);
}

/** Resolve exact workspace-relative paths only; never search by basename/hash/ID. */
function localResourcePath(root: DiscoveredTraeRoot, workspace: string, value: string): string | null {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,255}$/.test(workspace) || value.includes("\0")) return null;
  let decoded = value;
  if (decoded.startsWith("file:")) {
    try { decoded = fileURLToPath(decoded); } catch { return null; }
  }
  const workspaceRoot = path.resolve(root.workspaceStoragePath, workspace);
  const absolutePath = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(workspaceRoot, decoded);
  const relative = path.relative(workspaceRoot, absolutePath);
  const parts = relative.split(path.sep);
  const isPasteFile = parts[0] === "paste-files" && parts.length === 2;
  const isLongText = parts[0] === "long-text" && parts.length === 4 && path.extname(parts[3]) === ".txt";
  return isPasteFile || isLongText ? parts.join("/") : null;
}

function queryReferences(entries: readonly TraeQueryCacheEntry[]): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];
  for (const entry of entries) {
    for (const origin of entry.sources) {
      if (!origin.workspaceStorageId) continue;
      const source = (suffix: string): TraeResourceSource => ({
        kind: "query-cache-reference",
        locator: `${origin.locator}#${suffix}`,
        workspaceStorageId: origin.workspaceStorageId as string,
        sha256: origin.sha256,
      });
      const visit = (value: unknown, locator: string, depth = 0): void => {
        if (depth > 64) {
          candidates.push({ source: source(locator) });
          return;
        }
        if (Array.isArray(value)) {
          for (const [index, item] of value.entries()) visit(item, `${locator}[${index}]`, depth + 1);
        } else if (isRuntimeObject(value)) {
          for (const [key, item] of Object.entries(value)) {
            const field = `${locator}.${key}`;
            const isResourcePath =
              (key === "filePath" || key === "relatePath") && typeof item === "string" &&
              /(?:^|[\\/])(?:long-text|paste-files)(?:[\\/]|$)/.test(item);
            if (isResourcePath) candidates.push({ path: item as string, source: source(field) });
            visit(item, field, depth + 1);
          }
        }
      };
      visit(entry.parsedQuery, "parsedQuery");
      for (const [index, file] of entry.files.entries()) {
        candidates.push({
          path: file.resourceUri,
          declaredType: file.kind === "image" ? "image" : "attachment",
          mimeType: file.type,
          sizeBytes: file.sizeBytes,
          source: source(`files[${index}].resourceUri`),
        });
      }
      for (const [index, media] of entry.multiMedia.entries()) {
        // Remote resource IDs have no proven filename or local-cache join.
        candidates.push({
          declaredType: media.resourceType === "image" ? "image" : "unknown",
          source: source(`multiMedia[${index}]`),
        });
      }
    }
  }
  return candidates;
}

export function scanTraeResources(
  root: DiscoveredTraeRoot,
  productVersion: string,
  queryCacheEntries: readonly TraeQueryCacheEntry[] = [],
  explicitReferences: readonly TraeResourceReference[] = [],
): TraeResourceReport {
  if (productVersion !== "3.3.104") {
    throw new Trae2OpenCodeError("T2O_TRAE_RESOURCE_VERSION_UNSUPPORTED");
  }
  const report: TraeResourceReport = { resources: [], issues: [] };
  const resources = new Map<string, TraeResource>();
  const unreadable = new Set<string>();
  const issue = (
    code: TraeResourceIssueCode,
    context: Omit<TraeResourceIssue, "code" | "severity" | "message">,
    severity: "warning" | "error" = "warning",
  ) => report.issues.push({ code, severity, message: MESSAGES[code], ...context });

  const longText = scanTraeLongTextResources(root, productVersion);
  report.issues.push(...longText.issues.filter((item) => item.code !== "T2O_TRAE_LONG_TEXT_UNASSOCIATED"));
  for (const resource of longText.longTextResources) {
    const relativePath = `long-text/${resource.relativePath.split(path.sep).join("/")}`;
    const id = resourceId(resource.workspaceStorageId, relativePath);
    resources.set(id, {
      sourceId: id,
      workspaceStorageId: resource.workspaceStorageId,
      type: "long-text",
      availability: "available",
      relativePath,
      mimeType: "text/plain",
      sizeBytes: resource.sizeBytes,
      sha256: resource.contentSha256,
      sources: [{
        kind: "workspace-resource",
        locator: relativePath,
        workspaceStorageId: resource.workspaceStorageId,
        sha256: resource.contentSha256,
      }],
      references: [],
    });
  }

  let workspaces: fs.Dirent[] = [];
  if (root.availability.workspaceStorage) {
    try { workspaces = fs.readdirSync(root.workspaceStoragePath, { withFileTypes: true }); }
    catch { issue("T2O_TRAE_RESOURCE_SCAN_FAILED", {}, "error"); }
  }
  for (const workspace of workspaces.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!workspace.isDirectory()) continue;
    const workspaceStorageId = workspace.name;
    const directory = path.join(root.workspaceStoragePath, workspaceStorageId, "paste-files");
    let entries: fs.Dirent[];
    try {
      if (!fs.existsSync(directory)) continue;
      assertResourcePath(root.workspaceStoragePath, directory);
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      issue("T2O_TRAE_RESOURCE_SCAN_FAILED", { workspaceStorageId }, "error");
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = `paste-files/${entry.name}`;
      const id = resourceId(workspaceStorageId, relativePath);
      if (!entry.isFile()) {
        unreadable.add(id);
        issue("T2O_TRAE_RESOURCE_LAYOUT_INVALID", { workspaceStorageId, resourceId: id }, "error");
        continue;
      }
      try {
        const metadata = inspectResourceFile(root.workspaceStoragePath, path.join(directory, entry.name));
        resources.set(id, {
          sourceId: id, workspaceStorageId, relativePath,
          type: metadata.mimeType.startsWith("image/") ? "image" : "file",
          availability: "available", ...metadata,
          sources: [{
            kind: "workspace-resource", locator: relativePath, workspaceStorageId, sha256: metadata.sha256,
          }],
          references: [],
        });
        if (metadata.mimeType === "application/octet-stream") {
          issue("T2O_TRAE_RESOURCE_MIME_UNKNOWN", { workspaceStorageId, resourceId: id });
        }
      } catch {
        unreadable.add(id);
        issue("T2O_TRAE_RESOURCE_READ_FAILED", { workspaceStorageId, resourceId: id }, "error");
      }
    }
  }

  const references = queryReferences(queryCacheEntries);
  for (const [index, reference] of explicitReferences.entries()) {
    const validSession = reference.sourceSessionId === undefined || /^[A-Za-z0-9._:-]{8,128}$/.test(reference.sourceSessionId);
    const validMessage = reference.sourceMessageId === undefined || /^[A-Za-z0-9._:-]{1,256}$/.test(reference.sourceMessageId);
    const validWorkspace = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,255}$/.test(reference.workspaceStorageId);
    const validReference = validSession && validMessage && validWorkspace && typeof reference.path === "string";
    if (!validReference) {
      issue("T2O_TRAE_RESOURCE_REFERENCE_INVALID", { referenceSha256: runtimeHash(reference) }, "error");
      continue;
    }
    references.push({
      path: reference.path,
      source: {
        kind: "explicit-reference", locator: `explicit-resource-reference[${index}]`,
        sha256: runtimeHash(reference), workspaceStorageId: reference.workspaceStorageId,
        ...(reference.sourceSessionId ? { sourceSessionId: reference.sourceSessionId } : {}),
        ...(reference.sourceMessageId ? { sourceMessageId: reference.sourceMessageId } : {}),
      },
    });
  }
  for (const reference of references) {
    const { source } = reference;
    const context = {
      workspaceStorageId: source.workspaceStorageId,
      ...(source.sourceSessionId ? { sourceSessionId: source.sourceSessionId } : {}),
      ...(source.sourceMessageId ? { sourceMessageId: source.sourceMessageId } : {}),
      referenceSha256: source.sha256,
    };
    const relativePath = reference.path === undefined ? null : localResourcePath(root, source.workspaceStorageId, reference.path);
    if (!relativePath) {
      const looksLocal = reference.path !== undefined &&
        (reference.path.startsWith("file:") || path.isAbsolute(reference.path) ||
          /(?:^|[\\/])(?:long-text|paste-files)(?:[\\/]|$)/.test(reference.path));
      if (looksLocal || source.kind === "explicit-reference") {
        issue("T2O_TRAE_RESOURCE_REFERENCE_INVALID", context, "error");
        continue;
      }
      const id = runtimeHash({ source, path: reference.path });
      resources.set(id, {
        sourceId: id, workspaceStorageId: source.workspaceStorageId,
        type: reference.declaredType ?? "unknown", availability: "deferred",
        sources: [source], references: [source],
      });
      issue("T2O_TRAE_RESOURCE_DEFERRED", { ...context, resourceId: id });
      continue;
    }
    const id = resourceId(source.workspaceStorageId, relativePath);
    let resource = resources.get(id);
    if (!resource) {
      const filePath = path.join(root.workspaceStoragePath, source.workspaceStorageId, ...relativePath.split("/"));
      let missing = false;
      try { assertResourcePath(root.workspaceStoragePath, filePath); }
      catch (error) { missing = (error as NodeJS.ErrnoException).code === "ENOENT"; }
      const availability = missing && !unreadable.has(id) ? "missing" : "deferred";
      resource = {
        sourceId: id, workspaceStorageId: source.workspaceStorageId, relativePath,
        type: relativePath.startsWith("long-text/") ? "long-text" : reference.declaredType ?? "file",
        availability, sources: [source], references: [],
      };
      resources.set(id, resource);
      issue(availability === "missing" ? "T2O_TRAE_RESOURCE_MISSING" : "T2O_TRAE_RESOURCE_DEFERRED",
        { ...context, resourceId: id });
    }
    resource.references.push(source);
    const wrongSize = reference.sizeBytes !== undefined && resource.sizeBytes !== undefined && reference.sizeBytes !== resource.sizeBytes;
    const wrongMime = reference.mimeType !== undefined && resource.mimeType !== undefined && reference.mimeType !== resource.mimeType;
    if (wrongSize || wrongMime) {
      issue("T2O_TRAE_RESOURCE_METADATA_MISMATCH", { ...context, resourceId: id }, "error");
    }
  }
  for (const resource of resources.values()) {
    resource.sources = uniqueSources(resource.sources);
    resource.references = uniqueSources(resource.references);
    if (!resource.references.some((source) => source.sourceSessionId)) {
      issue("T2O_TRAE_RESOURCE_UNASSOCIATED", {
        workspaceStorageId: resource.workspaceStorageId, resourceId: resource.sourceId,
      });
    }
  }
  report.resources = [...resources.values()].sort((a, b) =>
    a.workspaceStorageId.localeCompare(b.workspaceStorageId) ||
    (a.relativePath ?? "").localeCompare(b.relativePath ?? "") || a.sourceId.localeCompare(b.sourceId));
  return report;
}
