import * as fs from "node:fs";
import * as path from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { ERROR_DEFINITIONS } from "../../shared/error-codes.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import type { TraePlatform } from "./path-discovery.js";

export type WorkspaceLocationKind = "folder" | "workspace";
export type ProjectPathSource =
  | "folder-uri"
  | "workspace-folder-path"
  | "workspace-folder-uri";

export type WorkspaceResolutionIssueCode =
  | "T2O_TRAE_WORKSPACE_METADATA_NOT_FOUND"
  | "T2O_TRAE_WORKSPACE_METADATA_INVALID"
  | "T2O_TRAE_WORKSPACE_URI_UNSUPPORTED"
  | "T2O_TRAE_WORKSPACE_CONFIG_NOT_FOUND"
  | "T2O_TRAE_WORKSPACE_CONFIG_INVALID";

export interface WorkspaceLocation {
  kind: WorkspaceLocationKind;
  path: string;
  exists: boolean;
}

export interface ResolvedProjectPath {
  path: string;
  source: ProjectPathSource;
  exists: boolean;
}

export interface ResolvedTraeWorkspace {
  workspaceStorageId: string;
  workspaceStoragePath: string;
  metadataPath: string;
  location: WorkspaceLocation;
  projects: ResolvedProjectPath[];
}

export interface WorkspaceResolutionIssue {
  code: WorkspaceResolutionIssueCode;
  severity: "warning" | "error";
  workspaceStorageId: string;
  entryIndex?: number;
  message: string;
}

export interface WorkspaceResolutionReport {
  workspaces: ResolvedTraeWorkspace[];
  issues: WorkspaceResolutionIssue[];
}

export interface WorkspaceResolutionOptions {
  platform: TraePlatform;
  workspaceStoragePath: string;
}

export interface ParsedWorkspaceLocation {
  kind: WorkspaceLocationKind;
  path: string;
}

type WorkspaceLocationErrorCode =
  | "T2O_TRAE_WORKSPACE_METADATA_INVALID"
  | "T2O_TRAE_WORKSPACE_URI_UNSUPPORTED";

const ENCODED_SEPARATOR_PATTERN = /%2f|%5c/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPathApi(platform: TraePlatform) {
  return platform === "win32" ? path.win32 : path.posix;
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

function createIssue(
  code: WorkspaceResolutionIssueCode,
  workspaceStorageId: string,
  severity: WorkspaceResolutionIssue["severity"],
  entryIndex?: number,
): WorkspaceResolutionIssue {
  return {
    code,
    severity,
    workspaceStorageId,
    ...(entryIndex === undefined ? {} : { entryIndex }),
    message: ERROR_DEFINITIONS[code].message,
  };
}

function throwLocationError(
  code: WorkspaceLocationErrorCode,
  cause?: unknown,
): never {
  throw new Trae2OpenCodeError(code, { cause });
}

function parseJsonc(
  serialized: string,
  errorCode:
    | "T2O_TRAE_WORKSPACE_METADATA_INVALID"
    | "T2O_TRAE_WORKSPACE_CONFIG_INVALID",
): unknown {
  const errors: ParseError[] = [];
  const value = parse(serialized, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || value === undefined) {
    throw new Trae2OpenCodeError(errorCode);
  }
  return value;
}

export function normalizeWorkspaceFileUri(
  uri: string,
  platform: TraePlatform,
): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (cause) {
    throwLocationError("T2O_TRAE_WORKSPACE_URI_UNSUPPORTED", cause);
  }

  const hasUnsupportedUrlParts =
    parsed.protocol !== "file:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    ENCODED_SEPARATOR_PATTERN.test(parsed.pathname);
  if (hasUnsupportedUrlParts) {
    throwLocationError("T2O_TRAE_WORKSPACE_URI_UNSUPPORTED");
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch (cause) {
    throwLocationError("T2O_TRAE_WORKSPACE_URI_UNSUPPORTED", cause);
  }

  if (platform === "darwin") {
    const hasUnsupportedHost =
      parsed.hostname.length > 0 && parsed.hostname !== "localhost";
    if (hasUnsupportedHost || !decodedPath.startsWith("/")) {
      throwLocationError("T2O_TRAE_WORKSPACE_URI_UNSUPPORTED");
    }
    return path.posix.normalize(decodedPath);
  }

  const isLocalHost =
    parsed.hostname.length === 0 || parsed.hostname === "localhost";
  if (!isLocalHost) {
    const uncPath = `\\\\${parsed.hostname}${decodedPath.replaceAll("/", "\\")}`;
    return path.win32.normalize(uncPath);
  }

  const hasDriveLetter = /^\/[A-Za-z]:(?:\/|$)/.test(decodedPath);
  if (!hasDriveLetter) {
    throwLocationError("T2O_TRAE_WORKSPACE_URI_UNSUPPORTED");
  }
  return path.win32.normalize(decodedPath.slice(1));
}

export function resolveWorkspaceLocation(
  metadata: unknown,
  platform: TraePlatform,
): ParsedWorkspaceLocation {
  if (!isRecord(metadata)) {
    throwLocationError("T2O_TRAE_WORKSPACE_METADATA_INVALID");
  }

  const hasFolder = Object.hasOwn(metadata, "folder");
  const hasWorkspace = Object.hasOwn(metadata, "workspace");
  if (hasFolder === hasWorkspace) {
    throwLocationError("T2O_TRAE_WORKSPACE_METADATA_INVALID");
  }

  const kind: WorkspaceLocationKind = hasFolder ? "folder" : "workspace";
  const uri = metadata[kind];
  if (typeof uri !== "string" || uri.length === 0) {
    throwLocationError("T2O_TRAE_WORKSPACE_METADATA_INVALID");
  }

  return {
    kind,
    path: normalizeWorkspaceFileUri(uri, platform),
  };
}

function resolveWorkspaceFolderEntry(
  entry: unknown,
  workspaceFilePath: string,
  platform: TraePlatform,
): Omit<ResolvedProjectPath, "exists"> {
  if (!isRecord(entry)) {
    throw new Trae2OpenCodeError(
      "T2O_TRAE_WORKSPACE_CONFIG_INVALID",
    );
  }

  const hasPath = Object.hasOwn(entry, "path");
  const hasUri = Object.hasOwn(entry, "uri");
  if (hasPath === hasUri) {
    throw new Trae2OpenCodeError(
      "T2O_TRAE_WORKSPACE_CONFIG_INVALID",
    );
  }

  if (hasPath) {
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      throw new Trae2OpenCodeError(
        "T2O_TRAE_WORKSPACE_CONFIG_INVALID",
      );
    }

    const pathApi = getPathApi(platform);
    return {
      path: pathApi.resolve(
        pathApi.dirname(workspaceFilePath),
        entry.path,
      ),
      source: "workspace-folder-path",
    };
  }

  if (typeof entry.uri !== "string" || entry.uri.length === 0) {
    throw new Trae2OpenCodeError(
      "T2O_TRAE_WORKSPACE_CONFIG_INVALID",
    );
  }
  return {
    path: normalizeWorkspaceFileUri(entry.uri, platform),
    source: "workspace-folder-uri",
  };
}

function resolveWorkspaceProjects(
  workspaceStorageId: string,
  workspaceFilePath: string,
  platform: TraePlatform,
): {
  projects: ResolvedProjectPath[];
  issues: WorkspaceResolutionIssue[];
} {
  if (!safeIsFile(workspaceFilePath)) {
    return {
      projects: [],
      issues: [
        createIssue(
          "T2O_TRAE_WORKSPACE_CONFIG_NOT_FOUND",
          workspaceStorageId,
          "warning",
        ),
      ],
    };
  }

  let config: unknown;
  try {
    config = parseJsonc(
      fs.readFileSync(workspaceFilePath, "utf8"),
      "T2O_TRAE_WORKSPACE_CONFIG_INVALID",
    );
  } catch {
    return {
      projects: [],
      issues: [
        createIssue(
          "T2O_TRAE_WORKSPACE_CONFIG_INVALID",
          workspaceStorageId,
          "error",
        ),
      ],
    };
  }

  if (!isRecord(config) || !Array.isArray(config.folders)) {
    return {
      projects: [],
      issues: [
        createIssue(
          "T2O_TRAE_WORKSPACE_CONFIG_INVALID",
          workspaceStorageId,
          "error",
        ),
      ],
    };
  }

  const projects: ResolvedProjectPath[] = [];
  const issues: WorkspaceResolutionIssue[] = [];
  for (const [entryIndex, entry] of config.folders.entries()) {
    try {
      const project = resolveWorkspaceFolderEntry(
        entry,
        workspaceFilePath,
        platform,
      );
      projects.push({
        ...project,
        exists: safeIsDirectory(project.path),
      });
    } catch (error) {
      const code =
        error instanceof Trae2OpenCodeError &&
        error.code === "T2O_TRAE_WORKSPACE_URI_UNSUPPORTED"
          ? error.code
          : "T2O_TRAE_WORKSPACE_CONFIG_INVALID";
      issues.push(createIssue(code, workspaceStorageId, "error", entryIndex));
    }
  }

  const pathKeys = new Set<string>();
  const deduplicatedProjects = projects.filter((project) => {
    const key =
      platform === "win32" ? project.path.toLowerCase() : project.path;
    if (pathKeys.has(key)) return false;
    pathKeys.add(key);
    return true;
  });

  return {
    projects: deduplicatedProjects,
    issues,
  };
}

function resolveWorkspaceDirectory(
  workspaceStoragePath: string,
  workspaceStorageId: string,
  platform: TraePlatform,
): {
  workspace: ResolvedTraeWorkspace | null;
  issues: WorkspaceResolutionIssue[];
} {
  const pathApi = getPathApi(platform);
  const storagePath = pathApi.join(
    workspaceStoragePath,
    workspaceStorageId,
  );
  const metadataPath = pathApi.join(storagePath, "workspace.json");
  if (!safeIsFile(metadataPath)) {
    return {
      workspace: null,
      issues: [
        createIssue(
          "T2O_TRAE_WORKSPACE_METADATA_NOT_FOUND",
          workspaceStorageId,
          "warning",
        ),
      ],
    };
  }

  let parsedLocation: ParsedWorkspaceLocation;
  try {
    const metadata = parseJsonc(
      fs.readFileSync(metadataPath, "utf8"),
      "T2O_TRAE_WORKSPACE_METADATA_INVALID",
    );
    parsedLocation = resolveWorkspaceLocation(metadata, platform);
  } catch (error) {
    const code: WorkspaceResolutionIssueCode =
      error instanceof Trae2OpenCodeError &&
      error.code === "T2O_TRAE_WORKSPACE_URI_UNSUPPORTED"
        ? error.code
        : "T2O_TRAE_WORKSPACE_METADATA_INVALID";
    return {
      workspace: null,
      issues: [createIssue(code, workspaceStorageId, "error")],
    };
  }

  if (parsedLocation.kind === "folder") {
    const projectExists = safeIsDirectory(parsedLocation.path);
    return {
      workspace: {
        workspaceStorageId,
        workspaceStoragePath: storagePath,
        metadataPath,
        location: {
          ...parsedLocation,
          exists: projectExists,
        },
        projects: [
          {
            path: parsedLocation.path,
            source: "folder-uri",
            exists: projectExists,
          },
        ],
      },
      issues: [],
    };
  }

  const resolution = resolveWorkspaceProjects(
    workspaceStorageId,
    parsedLocation.path,
    platform,
  );
  return {
    workspace: {
      workspaceStorageId,
      workspaceStoragePath: storagePath,
      metadataPath,
      location: {
        ...parsedLocation,
        exists: safeIsFile(parsedLocation.path),
      },
      projects: resolution.projects,
    },
    issues: resolution.issues,
  };
}

export function resolveTraeWorkspaces(
  options: WorkspaceResolutionOptions,
): WorkspaceResolutionReport {
  if (!safeIsDirectory(options.workspaceStoragePath)) {
    return {
      workspaces: [],
      issues: [],
    };
  }

  let workspaceStorageIds: string[];
  try {
    workspaceStorageIds = fs
      .readdirSync(options.workspaceStoragePath, {
        withFileTypes: true,
      })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    throw new Trae2OpenCodeError(
      "T2O_TRAE_WORKSPACE_STORAGE_UNREADABLE",
      { cause },
    );
  }

  const report: WorkspaceResolutionReport = {
    workspaces: [],
    issues: [],
  };
  for (const workspaceStorageId of workspaceStorageIds) {
    const resolution = resolveWorkspaceDirectory(
      options.workspaceStoragePath,
      workspaceStorageId,
      options.platform,
    );
    if (resolution.workspace) {
      report.workspaces.push(resolution.workspace);
    }
    report.issues.push(...resolution.issues);
  }

  return report;
}
