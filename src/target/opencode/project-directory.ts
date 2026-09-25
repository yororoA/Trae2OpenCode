import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SourceDescriptor } from "../../ir/types.js";
import type { ErrorCode } from "../../shared/error-codes.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";

type Platform = SourceDescriptor["platform"];
export interface ProjectPathMap { from: string; to: string }
export interface DirectoryResolution {
  sourcePath: string | null;
  targetDirectory: string | null;
  strategy: "preserved" | "mapped" | "fallback" | "unresolved";
  exists: boolean;
  writable: boolean;
  reasons: ErrorCode[];
}

const apiFor = (platform: Platform) => platform === "win32" ? path.win32 : path.posix;

/**
 * Windows reports a drive letter in upper case, and OpenCode persists the session
 * directory exactly as the importing process' cwd reports it. TRAE records the same
 * path with a lower-case drive, so canonicalize it here or the readback byte-compare
 * fails on an otherwise identical directory.
 */
function canonicalizeDriveLetter(value: string): string {
  return value.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

function normalize(value: string, platform: Platform): string {
  const api = apiFor(platform);
  const normalized = platform === "win32"
    ? canonicalizeDriveLetter(api.normalize(value))
    : api.normalize(value);
  const validWindowsRoot = /^[a-z]:\\/i.test(normalized) || /^\\\\(?![?.]\\)[^\\]+\\[^\\]+/.test(normalized);
  const validRoot = platform === "win32" ? validWindowsRoot : api.isAbsolute(value);
  if (!value || value.includes("\0") || !validRoot) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_PATH_MAP_INVALID");
  }
  const trimTrailingSeparator = normalized !== api.parse(normalized).root && normalized.endsWith(api.sep);
  return trimTrailingSeparator ? normalized.slice(0, -1) : normalized;
}

async function isDirectory(value: string): Promise<boolean> {
  try { return (await fs.stat(value)).isDirectory(); }
  catch { return false; }
}

/** Read-only preview and import use the same path policy; missing folders are never created. */
export async function resolveOpenCodeDirectory(options: {
  sourcePath?: string;
  sourcePlatform: Platform;
  targetPlatform?: Platform;
  pathMaps?: readonly ProjectPathMap[];
  fallbackDirectory?: string;
  directoryExists?: (directory: string) => Promise<boolean>;
}): Promise<DirectoryResolution> {
  const targetPlatform = options.targetPlatform ?? process.platform;
  if (!["darwin", "win32", "linux"].includes(targetPlatform)) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_DIRECTORY_INVALID");
  }
  const platform = targetPlatform as Platform;
  const sourceApi = apiFor(options.sourcePlatform);
  const targetApi = apiFor(platform);
  const key = (value: string) => options.sourcePlatform === "win32" ? value.toLowerCase() : value;
  const sourcePath = options.sourcePath === undefined ? null : normalize(options.sourcePath, options.sourcePlatform);
  const fallback = options.fallbackDirectory === undefined ? undefined : normalize(options.fallbackDirectory, platform);
  const maps = new Map<string, ProjectPathMap>();
  for (const mapping of options.pathMaps ?? []) {
    const from = normalize(mapping.from, options.sourcePlatform);
    const to = normalize(mapping.to, platform);
    const existing = maps.get(key(from));
    const sameTarget = existing && (platform === "win32"
      ? existing.to.toLowerCase() === to.toLowerCase() : existing.to === to);
    if (existing && !sameTarget) throw new Trae2OpenCodeError("T2O_OPENCODE_PATH_MAP_INVALID");
    maps.set(key(from), { from, to });
  }
  const result: DirectoryResolution = {
    sourcePath, targetDirectory: null, strategy: "unresolved", exists: false, writable: false, reasons: [],
  };
  if (sourcePath !== null) {
    // Most specific component-boundary prefix wins; '/repo' cannot match '/repo-old'.
    for (const mapping of [...maps.values()].sort((a, b) => b.from.length - a.from.length)) {
      const relative = sourceApi.relative(mapping.from, sourcePath);
      const inside = relative !== ".." && !relative.startsWith(`..${sourceApi.sep}`) && !sourceApi.isAbsolute(relative);
      if (!inside) continue;
      const segments = relative ? relative.split(sourceApi.sep) : [];
      // A POSIX filename containing a backslash must not become a Windows separator.
      const invalidWindowsSegment = platform === "win32" && segments.some((segment) =>
        /[<>:"/\\|?*]/.test(segment) || /[. ]$/.test(segment) ||
        [...segment].some((character) => character.charCodeAt(0) < 32));
      if (invalidWindowsSegment) throw new Trae2OpenCodeError("T2O_OPENCODE_PATH_MAP_INVALID");
      result.targetDirectory = targetApi.join(mapping.to, ...segments);
      result.strategy = "mapped";
      break;
    }
    const samePathDialect = (options.sourcePlatform === "win32") === (platform === "win32");
    if (result.targetDirectory === null && samePathDialect) {
      result.targetDirectory = sourcePath;
      result.strategy = "preserved";
    }
  }
  const exists = options.directoryExists ?? isDirectory;
  result.exists = result.targetDirectory !== null && await exists(result.targetDirectory);
  if (!result.exists && fallback !== undefined) {
    result.targetDirectory = fallback;
    result.strategy = "fallback";
    result.exists = await exists(fallback);
  }
  result.writable = result.exists;
  if (!result.writable) result.reasons.push("T2O_OPENCODE_DIRECTORY_INVALID");
  return result;
}
