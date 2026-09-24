import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MigrationBundle } from "../../ir/types.js";
import { redactMigrationBundleCredentials } from "../../migration/redact-credentials.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import { assertNoCredentials } from "../../shared/sensitive.js";
import { assembleTraeMigrationBundle, type TraeSessionMessageRead } from "./assemble-bundle.js";
import { requireTraeRoot, type TraeRootDiscoveryOptions } from "./path-discovery.js";
import { VERIFIED_TRAE_PRODUCT_VERSION } from "./profile-definitions.js";
import { runtimeHash } from "./reasoning-plan.js";
import { scanTraeResources } from "./resources.js";
import { createTraeRuntimeReader, type TraeRuntimeTransport } from "./runtime-reader.js";
import { readTraeSessionMetadata } from "./session-metadata.js";
import { readTraeUserMessages } from "./user-messages.js";
import { resolveTraeWorkspaces } from "./workspace-resolution.js";

export async function detectTraeVersion(productFile?: string): Promise<string> {
  const candidates = productFile ? [productFile] : process.platform === "darwin" ? [
    "/Applications/Trae CN.app/Contents/Resources/app/product.json",
    path.join(os.homedir(), "Applications/Trae CN.app/Contents/Resources/app/product.json"),
  ] : [
    path.join(process.env.LOCALAPPDATA ?? "", "Programs/Trae CN/resources/app/product.json"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Trae CN/resources/app/product.json"),
  ];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(await fs.readFile(candidate, "utf8"));
      if (value.applicationName === "trae-cn" && typeof value.appVersion === "string" &&
        /^\d+\.\d+\.\d+$/.test(value.appVersion)) return value.appVersion;
    } catch { /* Try the next installed product location. */ }
  }
  throw new Trae2OpenCodeError("T2O_TRAE_VERSION_UNAVAILABLE");
}

export interface CollectTraeOptions extends TraeRootDiscoveryOptions {
  productVersion: string;
  transport?: TraeRuntimeTransport;
  collectedAt?: string;
  session?: string;
  project?: string;
  redactCredentials?: boolean;
}

export function selectBundle(bundle: MigrationBundle, selection: { session?: string; project?: string }): MigrationBundle {
  if (!selection.session && !selection.project) return bundle;
  const pathApi = bundle.source.platform === "win32" ? path.win32 : path.posix;
  const key = (value: string) => {
    const normalized = pathApi.normalize(value);
    return bundle.source.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const sessions = bundle.sessions.filter((session) =>
    (!selection.session || session.sourceId === selection.session) &&
    (!selection.project || (session.projectPath !== undefined && key(session.projectPath) === key(selection.project))));
  if (sessions.length === 0) throw new Trae2OpenCodeError("T2O_MIGRATION_SELECTION_EMPTY");
  const ids = new Set(sessions.map((session) => session.sourceId));
  const projects = bundle.projects.filter((project) => sessions.some((session) => session.projectSourceId === project.sourceId));
  const diagnostics = bundle.diagnostics.filter((diagnostic) =>
    diagnostic.subject?.type !== "session" || ids.has(diagnostic.subject.sourceId ?? ""));
  return { ...bundle, sessions, projects, diagnostics };
}

export async function collectTraeBundle(options: CollectTraeOptions): Promise<MigrationBundle> {
  if (options.productVersion !== VERIFIED_TRAE_PRODUCT_VERSION) {
    throw new Trae2OpenCodeError("T2O_TRAE_PROFILE_VERSION_UNSUPPORTED");
  }
  const root = requireTraeRoot(options);
  const reader = options.transport ? createTraeRuntimeReader(options.transport) : undefined;
  if (reader && reader.productVersion !== options.productVersion) {
    throw new Trae2OpenCodeError("T2O_TRAE_PROFILE_VERSION_UNSUPPORTED");
  }
  const metadata = await readTraeSessionMetadata({
    root, productVersion: options.productVersion,
    ...(reader ? { runtimeMetadataProvider: ({ sourceSessionIds }) => reader.readMetadata(sourceSessionIds) } : {}),
  });
  const workspaces = resolveTraeWorkspaces(root);
  const cache = await readTraeUserMessages({ root, productVersion: options.productVersion, sourceSessionIds: [] });
  const resources = scanTraeResources(root, options.productVersion, cache.queryCacheEntries);
  const messageReads: TraeSessionMessageRead[] = [];
  let totalBytes = 0;
  for (const session of metadata.sessions) {
    if (options.session && session.sourceSessionId !== options.session) continue;
    if (!reader) continue;
    try {
      const read = await reader.readMessages(session.sourceSessionId);
      totalBytes += Buffer.byteLength(JSON.stringify(read.value), "utf8");
      if (totalBytes > 128 * 1024 * 1024) throw new Trae2OpenCodeError("T2O_TRAE_RUNTIME_LIMIT");
      messageReads.push({ sourceSessionId: session.sourceSessionId, status: "available", ...read });
    } catch (error) {
      if (error instanceof Trae2OpenCodeError && error.code === "T2O_TRAE_RUNTIME_LIMIT") throw error;
      messageReads.push({ sourceSessionId: session.sourceSessionId, status: "error" });
    }
  }
  const bundle = assembleTraeMigrationBundle({
    productVersion: options.productVersion, platform: root.platform,
    collectedAt: options.collectedAt ?? new Date().toISOString(),
    metadata, workspaces, messageReads, resources,
    queryCacheHashes: cache.queryCacheEntries.map((entry) => entry.sha256),
  });
  for (const issue of cache.issues) {
    bundle.diagnostics.push({
      id: runtimeHash(issue), code: issue.code, severity: issue.severity,
      message: issue.message, subject: { type: "bundle" }, sourceRefs: [],
    });
  }
  const selected = selectBundle(bundle, options);
  if (options.redactCredentials) {
    return redactMigrationBundleCredentials(selected).bundle;
  }
  assertNoCredentials(selected);
  return selected;
}
