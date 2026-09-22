/** TRAE 数据目录发现器 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { TraeDataRoots } from "./types";

export function getDefaultTraeUserDataPaths(
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
): string[] {
  if (platform === "darwin") {
    return ["Trae CN", "Trae"].map((product) =>
      path.join(homeDir, "Library", "Application Support", product, "User"),
    );
  }

  if (platform === "win32") {
    return [env.APPDATA, env.LOCALAPPDATA]
      .filter((root): root is string => Boolean(root))
      .flatMap((root) =>
        ["Trae CN", "Trae"].map((product) =>
          path.join(root, product, "User"),
        ),
      );
  }

  if (platform === "linux") {
    return ["Trae CN", "Trae"].map((product) =>
      path.join(homeDir, ".config", product, "User"),
    );
  }

  return [];
}

export function discoverTraeRoots(customRoot?: string): TraeDataRoots | null {
  const platform = process.platform;
  const candidates = customRoot
    ? [customRoot]
    : getDefaultTraeUserDataPaths(platform);

  for (const candidate of candidates) {
    const globalStoragePath = path.join(candidate, "globalStorage");
    const workspaceStoragePath = path.join(candidate, "workspaceStorage");

    // 至少存在一个目录才认为有效
    const globalExists = fs.existsSync(globalStoragePath);
    const wsExists = fs.existsSync(workspaceStoragePath);

    if (globalExists || wsExists) {
      return {
        os: platform as TraeDataRoots["os"],
        userDataPath: candidate,
        globalStoragePath,
        workspaceStoragePath,
      };
    }
  }

  // 部分存在也返回，方便诊断
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return {
        os: platform as TraeDataRoots["os"],
        userDataPath: candidate,
        globalStoragePath: path.join(candidate, "globalStorage"),
        workspaceStoragePath: path.join(candidate, "workspaceStorage"),
      };
    }
  }

  return null;
}

export function listWorkspaceDirs(
  workspaceStoragePath: string,
  maxWorkspaces?: number,
): string[] {
  if (!fs.existsSync(workspaceStoragePath)) return [];

  const entries = fs.readdirSync(workspaceStoragePath, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(workspaceStoragePath, e.name))
    .sort();

  return maxWorkspaces ? dirs.slice(0, maxWorkspaces) : dirs;
}
