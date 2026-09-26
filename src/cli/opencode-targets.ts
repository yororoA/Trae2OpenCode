import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  openCodeDialectForVersion,
  parseOpenCodeVersion,
  type OpenCodeDialect,
} from "../target/opencode/contract.js";
import { resolveOpenCodeBinary } from "../target/opencode/binary.js";

const exec = promisify(execFile);

export type OpenCodeTargetSource = "configured" | "path" | "desktop";

export type OpenCodeTargetCandidate = {
  dialect: OpenCodeDialect;
  version: string;
  binary: string;
  source: OpenCodeTargetSource;
};

export interface OpenCodeTargetDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  isFile?: (filename: string) => boolean;
  inspectBinary?: (binary: string) => Promise<Pick<OpenCodeTargetCandidate, "dialect" | "version">>;
}

export function desktopOpenCodeBinaryCandidates(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
} = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDirectory ?? os.homedir();
  if (platform === "darwin") {
    return [
      path.join("/Applications", "OpenCode.app", "Contents", "Resources", "opencode-cli"),
      path.join(home, "Applications", "OpenCode.app", "Contents", "Resources", "opencode-cli"),
    ];
  }
  if (platform !== "win32") return [];
  const roots = [
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs", "OpenCode"),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "OpenCode"),
    env.ProgramFiles && path.win32.join(env.ProgramFiles, "OpenCode"),
  ].filter((value): value is string => typeof value === "string");
  const names = ["opencode-cli.exe", "opencode.exe"];
  return roots.flatMap((root) =>
    names.flatMap((name) => [
      path.win32.join(root, "resources", name),
      path.win32.join(root, "Resources", name),
    ]));
}

export async function inspectOpenCodeBinary(binary: string): Promise<{
  dialect: OpenCodeDialect;
  version: string;
}> {
  try {
    const result = await exec(binary, ["--version"], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const version = parseOpenCodeVersion(result.stdout.trim() || result.stderr.trim());
    const dialect = openCodeDialectForVersion(version);
    if (!version || !dialect) throw new Error("Unsupported OpenCode version");
    return { dialect, version };
  } catch {
    throw new Error("OPENCODE_BINARY_UNSUPPORTED");
  }
}

export async function discoverOpenCodeTargets(
  options: OpenCodeTargetDiscoveryOptions = {},
): Promise<OpenCodeTargetCandidate[]> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? existsSync;
  const inspect = options.inspectBinary ?? inspectOpenCodeBinary;
  const versionSpecific = [
    { dialect: "v1" as const, value: env.T2O_OPENCODE_V1_BINARY },
    { dialect: "v2" as const, value: env.T2O_OPENCODE_V2_BINARY },
  ].filter((item): item is { dialect: OpenCodeDialect; value: string } =>
    typeof item.value === "string" && item.value.length > 0);
  const legacy = env.T2O_OPENCODE_BINARY;
  const specs: Array<{
    value: string;
    source: OpenCodeTargetSource;
    expectedDialect?: OpenCodeDialect;
  }> = [];
  if (versionSpecific.length === 0 && legacy) {
    specs.push({ value: legacy, source: "configured" });
  } else {
    specs.push(...versionSpecific.map((item) => ({
      value: item.value,
      source: "configured" as const,
      expectedDialect: item.dialect,
    })));
    specs.push({ value: "opencode", source: "path" });
    specs.push(...desktopOpenCodeBinaryCandidates({
      platform, env, homeDirectory: options.homeDirectory,
    }).filter(isFile).map((value) => ({ value, source: "desktop" as const })));
  }

  const candidates: OpenCodeTargetCandidate[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    const binary = resolveOpenCodeBinary(spec.value, { platform, env, isFile });
    try {
      const observed = await inspect(binary);
      if (spec.expectedDialect && observed.dialect !== spec.expectedDialect) {
        throw new Error("OPENCODE_BINARY_DIALECT_MISMATCH");
      }
      const resolved = platform === "win32"
        ? path.win32.resolve(binary).toLowerCase()
        : path.resolve(binary);
      const key = `${observed.dialect}\0${observed.version}\0${resolved}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ...observed, binary, source: spec.source });
    } catch (error) {
      if (spec.source === "configured") throw error;
    }
  }
  return candidates;
}

/** Keep one executable per dialect, preferring an explicit path or an active matching service. */
export function preferredOpenCodeTargets(
  candidates: readonly OpenCodeTargetCandidate[],
  activeVersions: Partial<Record<OpenCodeDialect, string>> = {},
): OpenCodeTargetCandidate[] {
  const sourcePriority: Record<OpenCodeTargetSource, number> = {
    configured: 0,
    path: 1,
    desktop: 2,
  };
  const score = (candidate: OpenCodeTargetCandidate) => {
    if (candidate.source === "configured") return 0;
    const active = activeVersions[candidate.dialect] === candidate.version;
    return (active ? 10 : 20) + sourcePriority[candidate.source];
  };
  return (["v1", "v2"] as const).flatMap((dialect) => {
    const matching = candidates.filter((candidate) => candidate.dialect === dialect)
      .sort((left, right) => score(left) - score(right));
    return matching.length ? [matching[0]] : [];
  });
}

export function requestedOpenCodeTargets(
  value: string | undefined,
  candidates: readonly OpenCodeTargetCandidate[],
): OpenCodeTargetCandidate[] | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "all" || normalized === "*") return [...candidates];
  const dialects = new Set(
    normalized.split(/[\s,，|]+/).filter(Boolean) as OpenCodeDialect[],
  );
  if (dialects.size === 0 || [...dialects].some((dialect) => dialect !== "v1" && dialect !== "v2")) {
    throw new Error("OPENCODE_TARGET_SELECTION_INVALID");
  }
  const selected = candidates.filter((candidate) => dialects.has(candidate.dialect));
  if (selected.length !== dialects.size) throw new Error("OPENCODE_TARGET_UNAVAILABLE");
  return selected;
}
