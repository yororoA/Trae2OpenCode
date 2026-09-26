import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface ResolveBinaryOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  isFile?: (candidate: string) => boolean;
  readText?: (candidate: string) => string | undefined;
}

/** npm's Windows shims for a native CLI; each one points at the real executable. */
const SHIM_EXTENSIONS = [".cmd", "", ".ps1"];
/** One quoted or bare token per match, so the interpreter and its script can be told apart. */
const TOKEN_PATTERN = /"([^"]+)"|'([^']+)'|([^\s"']+)/g;
/** Shell variables that name a path inside the shim's own installation directory. */
const DIRECTORY_VARIABLE = /%~?dp0%?/gi;
/** Tokens naming the shim's own interpreter, which is never the OpenCode executable. */
const INTERPRETER_NAMES = ["node", "node.exe", "cmd", "cmd.exe"];

const defaultIsFile = (candidate: string): boolean => existsSync(candidate);

/** Expand one shim token to an absolute Windows path, or drop it as unresolvable. */
function expandToken(token: string, directory: string): string | undefined {
  const expanded = token.replace(DIRECTORY_VARIABLE, directory).replace(/\$basedir/g, directory);
  // `%_prog%`, `%COMSPEC%` and `%*` stay literal: their value is not this resolver's to guess.
  if (expanded.includes("%")) return undefined;
  // A bare command name carries no installation directory to search.
  if (!/[/\\]/.test(expanded)) return undefined;
  return path.win32.resolve(expanded);
}

/**
 * npm installs the `opencode` command as shims on Windows, and Node cannot execute a
 * `.cmd`/shell shim directly. A shim either names a native executable, or runs a Node
 * launcher script with `node`.
 */
function shimTargets(
  shim: string,
  isFile: (candidate: string) => boolean,
  readText: (candidate: string) => string | undefined,
): { native?: string; launcher?: string } {
  const content = readText(shim);
  if (content === undefined) return {};
  const directory = path.win32.dirname(shim);
  let launcher: string | undefined;
  for (const match of content.matchAll(TOKEN_PATTERN)) {
    const candidate = expandToken(match[1] ?? match[2] ?? match[3], directory);
    if (candidate === undefined || !isFile(candidate)) continue;
    if (INTERPRETER_NAMES.includes(path.win32.basename(candidate).toLowerCase())) continue;
    if (path.win32.extname(candidate).toLowerCase() === ".exe") return { native: candidate };
    launcher ??= candidate;
  }
  return launcher === undefined ? {} : { launcher };
}

/**
 * Older `opencode-ai` releases ship `bin/opencode` as a Node launcher, and the native
 * executable lives in a platform package resolved from the launcher's own directory.
 * That package is resolved here rather than by running the launcher: an extra process
 * between the host and the server cannot be reached by `ChildProcess#kill` on Windows.
 */
function platformBinaryNear(
  launcher: string,
  arch: string,
  isFile: (candidate: string) => boolean,
): string | undefined {
  // npm publishes a `-baseline` build for x64, which runs on CPUs with and without AVX2.
  // The launcher probes the CPU instead; picking the universally compatible build avoids
  // that probe without ever selecting a binary this CPU cannot execute.
  const names = arch === "x64"
    ? ["opencode-windows-x64-baseline", "opencode-windows-x64"]
    : [`opencode-windows-${arch}`];
  let current = path.win32.dirname(launcher);
  for (;;) {
    const modules = path.win32.join(current, "node_modules");
    for (const name of names) {
      const candidate = path.win32.join(modules, name, "bin", "opencode.exe");
      if (isFile(candidate)) return candidate;
    }
    const parent = path.win32.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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
  if (path.win32.extname(binary).toLowerCase() === ".exe") return binary;
  const readText = options.readText ?? ((candidate: string) => {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      return undefined;
    }
  });
  const arch = options.arch ?? process.arch;

  const env = options.env ?? process.env;
  const directories = (env.PATH ?? env.Path ?? "").split(path.win32.delimiter).filter(Boolean);
  const search = /[\\/]/.test(binary) ? [""] : directories;
  const name = path.win32.basename(binary);
  for (const extension of SHIM_EXTENSIONS) {
    for (const directory of search) {
      const shim = path.win32.resolve(path.win32.join(directory, name + extension));
      if (!isFile(shim)) continue;
      const targets = shimTargets(shim, isFile, readText);
      if (targets.native !== undefined) return targets.native;
      // A launcher without its platform package resolves to nothing: the host can spawn
      // neither the launcher itself nor the missing executable.
      if (targets.launcher !== undefined) {
        const native = platformBinaryNear(targets.launcher, arch, isFile);
        if (native !== undefined) return native;
      }
    }
  }
  return binary;
}