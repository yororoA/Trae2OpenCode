import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface ResolveBinaryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isFile?: (candidate: string) => boolean;
  readText?: (candidate: string) => string | undefined;
}

/** npm's Windows shims for a native CLI; each one points at the real executable. */
const SHIM_EXTENSIONS = [".cmd", "", ".ps1"];
const EXECUTABLE_PATTERN = /"?([^"\s]*\.exe)"?/gi;

const defaultIsFile = (candidate: string): boolean => existsSync(candidate);

/**
 * npm installs the `opencode` command as shims on Windows, and Node cannot execute a
 * `.cmd`/shell shim directly, so the native executable inside the shim is resolved instead.
 */
function nativeTargetInShim(
  shim: string,
  isFile: (candidate: string) => boolean,
  readText: (candidate: string) => string | undefined,
): string | undefined {
  const content = readText(shim);
  if (content === undefined) return undefined;
  const directory = path.dirname(shim);
  for (const match of content.matchAll(EXECUTABLE_PATTERN)) {
    const expanded = match[1]
      .replace(/%dp0%|%~dp0%/gi, directory)
      .replace(/\$basedir/g, directory);
    const candidate = path.resolve(expanded);
    // A Node-hosted shim resolves `node.exe`, which is not the OpenCode executable.
    if (path.basename(candidate).toLowerCase() === "node.exe") continue;
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve a configured OpenCode executable to something the host can spawn directly.
 * Anything that already exists as a file, and every non-Windows platform, is returned as is.
 */
export function resolveOpenCodeBinary(
  binary: string,
  options: ResolveBinaryOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || binary.length === 0) return binary;
  const isFile = options.isFile ?? defaultIsFile;
  if (isFile(binary)) return binary;
  // An explicit `.exe` path is reported exactly as configured when it does not exist.
  if (path.extname(binary).toLowerCase() === ".exe") return binary;
  const readText = options.readText ?? ((candidate: string) => {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      return undefined;
    }
  });

  const env = options.env ?? process.env;
  const directories = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const search = /[\\/]/.test(binary) ? [""] : directories;
  const name = path.basename(binary);
  for (const extension of SHIM_EXTENSIONS) {
    for (const directory of search) {
      const shim = path.resolve(path.join(directory, name + extension));
      if (!isFile(shim)) continue;
      const native = nativeTargetInShim(shim, isFile, readText);
      if (native !== undefined) return native;
    }
  }
  return binary;
}