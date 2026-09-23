import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Trae2OpenCodeError } from "../../shared/errors.js";

export type TraePlatform = "darwin" | "win32";
export type TraeProduct = "trae-cn" | "trae" | "custom";
export type TraeRootSource = "default" | "override";

export interface TraeRootAvailability {
  globalStorage: boolean;
  workspaceStorage: boolean;
  modularData: boolean;
}

export interface DiscoveredTraeRoot {
  platform: TraePlatform;
  product: TraeProduct;
  source: TraeRootSource;
  productDataPath: string;
  userDataPath: string;
  globalStoragePath: string;
  workspaceStoragePath: string;
  modularDataPath: string;
  availability: TraeRootAvailability;
}

export interface TraeRootDiscoveryOptions {
  traeRoot?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  isDirectory?: (candidatePath: string) => boolean;
}

interface RootCandidate {
  root: Omit<DiscoveredTraeRoot, "availability">;
  allowEmptyUserData: boolean;
}

const PRODUCT_DIRECTORY_NAMES = ["Trae CN", "Trae"] as const;

function isSupportedPlatform(
  platform: NodeJS.Platform,
): platform is TraePlatform {
  return platform === "darwin" || platform === "win32";
}

function getPathApi(platform: TraePlatform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function deduplicatePaths(
  paths: readonly string[],
  platform: TraePlatform,
): string[] {
  const seen = new Set<string>();
  return paths.filter((candidatePath) => {
    const key =
      platform === "win32" ? candidatePath.toLowerCase() : candidatePath;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferProduct(
  productDataPath: string,
  platform: TraePlatform,
): TraeProduct {
  const directoryName = getPathApi(platform)
    .basename(productDataPath)
    .toLowerCase();

  if (directoryName === "trae cn") return "trae-cn";
  if (directoryName === "trae") return "trae";
  return "custom";
}

function createCandidate(
  userDataPath: string,
  productDataPath: string,
  platform: TraePlatform,
  source: TraeRootSource,
  allowEmptyUserData: boolean,
): RootCandidate {
  const pathApi = getPathApi(platform);
  return {
    root: {
      platform,
      product: inferProduct(productDataPath, platform),
      source,
      productDataPath,
      userDataPath,
      globalStoragePath: pathApi.join(userDataPath, "globalStorage"),
      workspaceStoragePath: pathApi.join(userDataPath, "workspaceStorage"),
      modularDataPath: pathApi.join(productDataPath, "ModularData"),
    },
    allowEmptyUserData,
  };
}

function expandRootPath(
  rootPath: string,
  homeDir: string,
  platform: TraePlatform,
): string {
  const pathApi = getPathApi(platform);
  const isHomeRelative =
    rootPath === "~" || rootPath.startsWith("~/") || rootPath.startsWith("~\\");
  const expanded = isHomeRelative
    ? pathApi.join(homeDir, rootPath.slice(rootPath === "~" ? 1 : 2))
    : rootPath;
  return pathApi.resolve(expanded);
}

function getOverrideCandidates(
  rootPath: string,
  homeDir: string,
  platform: TraePlatform,
): RootCandidate[] {
  if (rootPath.length === 0) return [];

  const pathApi = getPathApi(platform);
  const normalizedRoot = expandRootPath(rootPath, homeDir, platform);
  const isUserDataPath =
    pathApi.basename(normalizedRoot).toLowerCase() === "user";

  if (isUserDataPath) {
    return [
      createCandidate(
        normalizedRoot,
        pathApi.dirname(normalizedRoot),
        platform,
        "override",
        true,
      ),
    ];
  }

  return [
    createCandidate(
      pathApi.join(normalizedRoot, "User"),
      normalizedRoot,
      platform,
      "override",
      true,
    ),
    createCandidate(
      normalizedRoot,
      pathApi.dirname(normalizedRoot),
      platform,
      "override",
      false,
    ),
  ];
}

function defaultIsDirectory(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

export function getDefaultTraeUserDataPaths(
  options: Pick<
    TraeRootDiscoveryOptions,
    "platform" | "homeDir" | "env"
  > = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (!isSupportedPlatform(platform)) return [];

  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const pathApi = getPathApi(platform);

  if (platform === "darwin") {
    return PRODUCT_DIRECTORY_NAMES.map((productDirectory) =>
      pathApi.join(
        homeDir,
        "Library",
        "Application Support",
        productDirectory,
        "User",
      ),
    );
  }

  const roamingApplicationData =
    env.APPDATA || pathApi.join(homeDir, "AppData", "Roaming");
  const localApplicationData =
    env.LOCALAPPDATA || pathApi.join(homeDir, "AppData", "Local");
  const applicationDataDirectories = deduplicatePaths(
    [roamingApplicationData, localApplicationData],
    platform,
  );

  return applicationDataDirectories.flatMap((applicationDataDirectory) =>
    PRODUCT_DIRECTORY_NAMES.map((productDirectory) =>
      pathApi.join(applicationDataDirectory, productDirectory, "User"),
    ),
  );
}

function getDefaultCandidates(
  options: TraeRootDiscoveryOptions,
  platform: TraePlatform,
  homeDir: string,
): RootCandidate[] {
  const pathApi = getPathApi(platform);
  return getDefaultTraeUserDataPaths({
    platform,
    homeDir,
    env: options.env,
  }).map((userDataPath) =>
    createCandidate(
      userDataPath,
      pathApi.dirname(userDataPath),
      platform,
      "default",
      true,
    ),
  );
}

function inspectCandidate(
  candidate: RootCandidate,
  isDirectory: (candidatePath: string) => boolean,
): DiscoveredTraeRoot | null {
  if (!isDirectory(candidate.root.userDataPath)) return null;

  const availability = {
    globalStorage: isDirectory(candidate.root.globalStoragePath),
    workspaceStorage: isDirectory(candidate.root.workspaceStoragePath),
    modularData: isDirectory(candidate.root.modularDataPath),
  };
  const hasStorageAnchor =
    availability.globalStorage || availability.workspaceStorage;

  if (!candidate.allowEmptyUserData && !hasStorageAnchor) return null;
  return {
    ...candidate.root,
    availability,
  };
}

export function discoverTraeRoot(
  options: TraeRootDiscoveryOptions = {},
): DiscoveredTraeRoot | null {
  const platform = options.platform ?? process.platform;
  if (!isSupportedPlatform(platform)) return null;

  const homeDir = options.homeDir ?? os.homedir();
  const candidates =
    options.traeRoot !== undefined
      ? getOverrideCandidates(options.traeRoot, homeDir, platform)
      : getDefaultCandidates(options, platform, homeDir);
  const isDirectory = options.isDirectory ?? defaultIsDirectory;
  let emptyUserDataRoot: DiscoveredTraeRoot | null = null;

  for (const candidate of candidates) {
    const discovered = inspectCandidate(candidate, isDirectory);
    if (!discovered) continue;

    const hasStorageAnchor =
      discovered.availability.globalStorage ||
      discovered.availability.workspaceStorage;
    if (hasStorageAnchor) return discovered;
    emptyUserDataRoot ??= discovered;
  }

  return emptyUserDataRoot;
}

export function requireTraeRoot(
  options: TraeRootDiscoveryOptions = {},
): DiscoveredTraeRoot {
  const discovered = discoverTraeRoot(options);
  if (discovered) return discovered;

  const platform = options.platform ?? process.platform;
  const code = isSupportedPlatform(platform)
    ? "T2O_TRAE_ROOT_NOT_FOUND"
    : "T2O_TRAE_PLATFORM_UNSUPPORTED";
  throw new Trae2OpenCodeError(code);
}
