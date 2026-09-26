import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { MigrationBundle } from "../ir/types.js";
import { readBundleFile } from "../migration/bundle-file.js";
import { readManifest, type MigrationManifest } from "../migration/manifest.js";
import { createMigrationTarget } from "../migration/target.js";
import { formatByteLimit, MAX_BUNDLE_BYTES } from "../shared/limits.js";
import { connectTraeRuntime } from "../source/trae/runtime-cdp.js";
import { createTraeRuntimeReader } from "../source/trae/runtime-reader.js";
import {
  parseTraeRuntimeSessionMetadata,
  type TraeSessionMetadata,
} from "../source/trae/session-metadata.js";
import {
  openCodeDialectForVersion,
  parseOpenCodeVersion,
  VERIFIED_OPENCODE_VERSIONS,
  type OpenCodeDialect,
} from "../target/opencode/contract.js";
import { probeOpenCodeCapabilities } from "../target/opencode/capability-probe.js";
import { createOpenCodeTransport } from "../target/opencode/transport.js";
import {
  discoverOpenCodeTargets,
  preferredOpenCodeTargets,
  requestedOpenCodeTargets,
  type OpenCodeTargetCandidate,
} from "./opencode-targets.js";

const INTERACTIVE_EXPORT_REVISION = 11;
const ARTIFACT_DIRECTORY = /^session-[a-f0-9]{16}$/;
const WORKBENCH_URL =
  /\/out\/vs\/code\/electron-browser\/workbench\/workbench\.html(?:\?|$)/;

type WorkbenchTarget = {
  id: string;
  title: string;
  url: string;
};

export type SessionChoice = {
  id: string;
  title: string;
  metadataStatus: string;
  updatedAt?: number;
};

const METADATA_STATUS_LABELS: Record<string, string> = {
  complete: "元数据完整",
  partial: "元数据部分可用",
  invalid: "元数据有问题",
};

export type MigrationDirectories = {
  exportDirectory: string;
  runDirectory: string;
};

export type ArtifactCleanupResult = {
  exportDirectories: number;
  runDirectories: number;
};

function selectionKey(
  sourceSessionId: string,
  sourceUpdatedAt?: number,
  targetDialect?: OpenCodeDialect,
): string {
  const identity = [
    INTERACTIVE_EXPORT_REVISION,
    sourceSessionId,
    sourceUpdatedAt ?? null,
    ...(targetDialect ? [targetDialect] : []),
  ];
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 16);
}

export function resolveMigrationDirectories(
  rootDirectory: string,
  sourceSessionId: string,
  exportOverride?: string,
  runOverride?: string,
  sourceUpdatedAt?: number,
  targetDialect?: OpenCodeDialect,
): MigrationDirectories {
  const exportRoot = path.resolve(exportOverride ?? path.join(rootDirectory, "trae-export"));
  const runRoot = path.resolve(runOverride ?? path.join(rootDirectory, "migration-run"));
  const hasExportOverride = exportOverride !== undefined;
  const hasRunOverride = runOverride !== undefined;
  const exportKey = `session-${selectionKey(sourceSessionId, sourceUpdatedAt)}`;
  const runKey = `session-${selectionKey(sourceSessionId, sourceUpdatedAt, targetDialect)}`;
  return {
    exportDirectory: hasExportOverride ? exportRoot : path.join(exportRoot, exportKey),
    runDirectory: hasRunOverride ? runRoot : path.join(runRoot, runKey),
  };
}

export function parseChoiceIndex(answer: string, count: number): number | undefined {
  const index = Number.parseInt(answer.trim(), 10) - 1;
  return Number.isInteger(index) && index >= 0 && index < count ? index : undefined;
}

export function parseChoiceIndexes(answer: string, count: number): number[] | undefined {
  const normalized = answer.trim().toLowerCase();
  if (count <= 0 || normalized.length === 0) return undefined;
  if (normalized === "all" || normalized === "*" || normalized === "全部") {
    return Array.from({ length: count }, (_, index) => index);
  }

  const selected = new Set<number>();
  for (const token of normalized.split(/[\s,，]+/)) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end > count || start > end) return undefined;
      for (let value = start; value <= end; value++) selected.add(value - 1);
      continue;
    }
    if (!/^\d+$/.test(token)) return undefined;
    const value = Number(token);
    if (value < 1 || value > count) return undefined;
    selected.add(value - 1);
  }
  return selected.size > 0 ? [...selected].sort((left, right) => left - right) : undefined;
}

export function formatMetadataStatus(status: string): string {
  return METADATA_STATUS_LABELS[status] ?? "元数据状态未知";
}

function runtimeMetadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function buildSessionChoices(
  sessions: readonly TraeSessionMetadata[],
  records: readonly unknown[],
): SessionChoice[] {
  const metadata = new Map(
    records
      .map(runtimeMetadataRecord)
      .filter((record): record is Record<string, unknown> => record !== undefined)
      .map((record) => [String(record.chat_session_id), record]),
  );
  return sessions.map((session) => {
    const record = metadata.get(session.sourceSessionId);
    return {
      id: session.sourceSessionId,
      title: typeof record?.title === "string" && record.title.trim()
        ? record.title.replace(/\s+/g, " ").trim()
        : "未命名会话",
      metadataStatus: formatMetadataStatus(session.metadataStatus),
      updatedAt: typeof record?.updated_at === "string"
        ? Number(record.updated_at)
        : session.updatedAt,
    };
  });
}

export function bundleMatchesSession(
  bundle: MigrationBundle,
  sourceSessionId: string,
): boolean {
  return bundle.sessions.length === 1 && bundle.sessions[0].sourceId === sourceSessionId;
}

/** Release only an empty leaf so the exporter can claim it exclusively. */
export async function prepareExportDirectory(directory: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if ((await fs.readdir(directory)).length > 0) return false;
    await fs.rmdir(directory);
    return true;
  } catch (error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
  }
}

/** Quarantine a run leaf containing only an unlocked orphan manifest lock. */
export async function prepareRunDirectory(directory: string): Promise<boolean> {
  if (await prepareExportDirectory(directory)) return true;
  const lockName = "migration-manifest.json.lock";
  const lockPath = path.join(directory, lockName);
  let database: Database.Database | undefined;
  try {
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return false;
    const entries = await fs.readdir(directory);
    if (entries.length !== 1 || entries[0] !== lockName) return false;
    const lockStat = await fs.lstat(lockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.nlink !== 1) return false;
    database = new Database(lockPath, { timeout: 0 });
    database.exec("BEGIN EXCLUSIVE");
    database.exec("ROLLBACK");
    database.close();
    database = undefined;
    const currentDirectory = await fs.lstat(directory);
    const currentLock = await fs.lstat(lockPath);
    if (currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino ||
      currentLock.dev !== lockStat.dev || currentLock.ino !== lockStat.ino ||
      (await fs.readdir(directory)).join("\0") !== lockName) return false;
    const quarantine = `${directory}-orphan-lock-${randomUUID()}`;
    await fs.rename(directory, quarantine);
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

export function isTerminalManifestForSession(
  manifest: MigrationManifest,
  sourceSessionId: string,
): boolean {
  const terminalStates = new Set(["verified", "skipped", "excluded", "blocked", "rolled-back"]);
  return manifest.sessions.length > 0 &&
    manifest.sessions.every((item) =>
      item.sourceId === sourceSessionId && terminalStates.has(item.state));
}

export function isReplacementManifestForSession(
  manifest: MigrationManifest,
  sourceSessionId: string,
  targetDialect?: OpenCodeDialect,
): boolean {
  const session = manifest.sessions[0];
  const manifestDialect = openCodeDialectForVersion(manifest.target.serverVersion);
  return manifest.rollbackState === undefined &&
    manifest.sessions.length === 1 &&
    session.sourceId === sourceSessionId &&
    session.state === "verified" &&
    session.created &&
    session.deletionHash !== undefined &&
    (targetDialect === undefined || manifestDialect === targetDialect);
}

export function replacementResumeNeedsExclusiveAccess(
  manifest: MigrationManifest,
): boolean {
  return manifest.sessions.some((session) =>
    session.replacement !== undefined && session.replacement.state !== "deleted");
}

export function confirmsOverwrite(answer: string): boolean {
  return answer.trim() === "OVERWRITE";
}

export type OverwritePolicy = "prompt" | "overwrite" | "skip";

export function resolveOverwritePolicy(
  args: readonly string[],
  npmConfigYes?: string,
  replaceExisting?: string,
): OverwritePolicy | undefined {
  if (args.some((arg) => arg !== "-y" && arg !== "-n")) return undefined;
  const hasYes = args.includes("-y");
  const hasNo = args.includes("-n");
  if (hasYes && hasNo) return undefined;

  const argumentPolicy = hasYes ? "overwrite" : hasNo ? "skip" : undefined;
  const normalizedNpmConfig = npmConfigYes?.trim().toLowerCase();
  const npmPolicy = npmConfigYes === undefined
    ? undefined
    : normalizedNpmConfig === "true" || normalizedNpmConfig === "1"
      ? "overwrite"
      : normalizedNpmConfig === "" || normalizedNpmConfig === "false" ||
          normalizedNpmConfig === "0"
        ? "skip"
        : undefined;
  if (argumentPolicy && npmPolicy && argumentPolicy !== npmPolicy) return undefined;
  return argumentPolicy ?? npmPolicy ?? (replaceExisting === "1" ? "overwrite" : "prompt");
}

export type InteractiveMigrationMode = {
  name: "create" | "replace" | "resume";
  args: string[];
};

export function migrationProgressMessage(mode: InteractiveMigrationMode["name"]): string {
  if (mode === "replace") {
    return "迁移方式：OVERWRITE。正在校验旧目标；通过后将删除旧目标并导入当前版本...";
  }
  if (mode === "resume") {
    return "迁移方式：使用当前 manifest 续跑。将按 checkpoint 恢复任务或仅回读校验...";
  }
  return "迁移方式：首次导入。正在写入 OpenCode 并回读校验...";
}

export function migrationCompletionMessage(
  mode: InteractiveMigrationMode["name"],
  runDirectory: string,
): string {
  if (mode === "replace") {
    return "本次结果：已执行 OVERWRITE，旧目标已安全替换，当前版本通过回读校验。";
  }
  if (mode === "resume") {
    return "本次结果：当前 manifest 已完成并通过回读校验；未启动新的 OVERWRITE。";
  }
  return `本次结果：已新建会话并通过回读校验。迁移记录：${runDirectory}`;
}

export function resolveInteractiveMigrationMode(options: {
  manifest: string;
  runDirectory: string;
  manifestExists: boolean;
  runDirectoryExists: boolean;
  replacementManifest?: string;
  resumeNeedsExclusiveAccess: boolean;
}): InteractiveMigrationMode | undefined {
  if (options.manifestExists) {
    return {
      name: "resume",
      args: [
        "--resume", options.manifest,
        ...(options.resumeNeedsExclusiveAccess ? ["--exclusive-target"] : []),
      ],
    };
  }
  if (options.runDirectoryExists) return undefined;
  if (options.replacementManifest) {
    return {
      name: "replace",
      args: [
        "--output", options.runDirectory,
        "--replace", options.replacementManifest,
        "--exclusive-target",
      ],
    };
  }
  return { name: "create", args: ["--output", options.runDirectory] };
}

export async function findReplacementManifest(options: {
  sourceSessionId: string;
  runRoot: string;
  currentRunDirectory: string;
  targetDialect?: OpenCodeDialect;
}): Promise<string | undefined> {
  const candidates: Array<{ filename: string; modifiedAt: number }> = [];
  const entries = await fs.readdir(options.runRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !ARTIFACT_DIRECTORY.test(entry.name)) continue;
    const directory = path.resolve(options.runRoot, entry.name);
    if (directory === path.resolve(options.currentRunDirectory)) continue;
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const filename = path.join(directory, "migration-manifest.json");
      const manifest = await readManifest(filename);
      if (!isReplacementManifestForSession(
        manifest,
        options.sourceSessionId,
        options.targetDialect,
      )) continue;
      candidates.push({ filename, modifiedAt: stat.mtimeMs });
    } catch {
      // Invalid or active artifacts cannot authorize replacement.
    }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt ||
    left.filename.localeCompare(right.filename));
  return candidates[0]?.filename;
}

export async function replacementTargetExists(
  manifestFilename: string,
  readSession: (targetId: string) => Promise<unknown | null>,
): Promise<boolean> {
  const manifest = await readManifest(manifestFilename);
  const targetId = manifest.sessions[0]?.targetId;
  return typeof targetId === "string" && await readSession(targetId) !== null;
}

async function removeUnchangedDirectory(directory: string, initial: Awaited<ReturnType<typeof fs.lstat>>) {
  const current = await fs.lstat(directory);
  if (!current.isDirectory() || current.isSymbolicLink() ||
    current.dev !== initial.dev || current.ino !== initial.ino) return false;
  await fs.rm(directory, { recursive: true });
  return true;
}

/** Remove only validated, terminal revisions superseded by the current verified run. */
export async function cleanupObsoleteArtifacts(options: {
  sourceSessionId: string;
  exportRoot: string;
  runRoot: string;
  currentExportDirectory: string;
  currentRunDirectory: string;
  targetDialect?: OpenCodeDialect;
}): Promise<ArtifactCleanupResult> {
  const result = { exportDirectories: 0, runDirectories: 0 };
  const cleanupRoot = async (
    root: string,
    currentDirectory: string,
    kind: "export" | "run",
  ) => {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !ARTIFACT_DIRECTORY.test(entry.name)) continue;
      const directory = path.resolve(root, entry.name);
      if (directory === path.resolve(currentDirectory)) continue;
      try {
        const initial = await fs.lstat(directory);
        if (!initial.isDirectory() || initial.isSymbolicLink()) continue;
        if (kind === "export") {
          const bundle = await readBundleFile(path.join(directory, "migration-bundle.json"));
          if (!bundleMatchesSession(bundle, options.sourceSessionId)) continue;
        } else {
          const manifest = await readManifest(path.join(directory, "migration-manifest.json"));
          if (!isTerminalManifestForSession(manifest, options.sourceSessionId)) continue;
          if (options.targetDialect !== undefined &&
            openCodeDialectForVersion(manifest.target.serverVersion) !== options.targetDialect) continue;
        }
        if (!await removeUnchangedDirectory(directory, initial)) continue;
        if (kind === "export") result.exportDirectories++;
        else result.runDirectories++;
      } catch {
        // Invalid, active or concurrently changed artifacts are retained.
      }
    }
  };
  await cleanupRoot(options.exportRoot, options.currentExportDirectory, "export");
  await cleanupRoot(options.runRoot, options.currentRunDirectory, "run");
  return result;
}

function friendlyCode(outputText: string): string {
  for (const line of outputText.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as { code?: unknown };
      if (typeof value.code === "string") return value.code;
    } catch {
      // Ignore progress text and inspect the next line.
    }
  }
  return "";
}

function printFailure(outputText: string, server: string): void {
  switch (friendlyCode(outputText)) {
    case "T2O_TRAE_RUNTIME_UNAVAILABLE":
      console.error("无法连接 TRAE。请确认 TRAE 已开启本机调试端口。");
      break;
    case "T2O_TRAE_RUNTIME_LIMIT":
      console.error("所选会话仍然超过大小限制，请选择更小的会话。");
      break;
    case "T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING":
      console.error("疑似凭据位于无法安全改写的标识、路径或来源字段，已停止迁移。");
      break;
    case "T2O_OPENCODE_REQUEST_FAILED":
      console.error(`无法连接 OpenCode，请确认服务正在运行：${server}`);
      break;
    case "T2O_OPENCODE_VERSION_UNSUPPORTED":
      console.error("OpenCode 版本格式、主版本或预发布状态不受支持；当前可检测稳定的 v1/v2 版本。");
      break;
    case "T2O_OPENCODE_SCHEMA_UNSUPPORTED":
      console.error("OpenCode 实际协议与迁移契约不一致，已停止迁移。");
      break;
    case "T2O_OPENCODE_COMPATIBILITY_BINARY_REQUIRED":
      console.error("未收录的 OpenCode 版本需要同版本 CLI 执行隔离验证；请用 T2O_OPENCODE_BINARY 指定。");
      break;
    case "T2O_OPENCODE_COMPATIBILITY_UNVERIFIED":
      console.error("OpenCode 协议检查通过，但隔离导入、回读或删除验证失败，未向目标写入会话。");
      break;
    case "T2O_OPENCODE_V1_UNSUPPORTED_STATE":
      console.error(
        "所选会话含有 OpenCode 1.x 无法在不编造数据的前提下保存的状态，已停止迁移。",
      );
      break;
    case "T2O_MIGRATION_PLAN_CHANGED":
      console.error("迁移内容与已有续跑记录不一致，请恢复原会话或使用新的迁移目录。");
      break;
    case "T2O_MIGRATION_TARGET_CHANGED":
      console.error("OpenCode 服务与已有续跑记录不一致，已停止以保护目标会话。");
      break;
    case "T2O_MIGRATION_REPLACEMENT_INVALID":
      console.error("旧 manifest 无法证明目标会话归属，未执行覆盖。");
      break;
    case "T2O_MIGRATION_CHILDREN_PROTECTED":
      console.error("目标会话包含迁移范围外的子会话，未执行覆盖。");
      break;
    case "T2O_MIGRATION_EXCLUSIVE_REQUIRED":
      console.error("覆盖需要独占 OpenCode 写入权限，请暂停其他写入后重新确认。");
      break;
    default:
      console.error("迁移未完成，请检查 TRAE、OpenCode 和迁移目录。");
  }
}

type CliRunResult = {
  ok: boolean;
  code: string;
  outputText: string;
};

export function cliJsonResult(outputText: string): Record<string, unknown> | undefined {
  for (const line of outputText.trim().split(/\r?\n/).reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Ignore non-JSON progress output.
    }
  }
  return undefined;
}

export function localServerUrl(outputText: string): string | undefined {
  return outputText.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
}

export type OpenCodeServiceDescriptor = {
  url: string;
  password: string;
  version: string;
};

export function parseOpenCodeServiceDescriptor(value: unknown): OpenCodeServiceDescriptor | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = value as Record<string, unknown>;
  const url = typeof descriptor.url === "string" ? localServerUrl(descriptor.url) : undefined;
  const password = typeof descriptor.password === "string" ? descriptor.password : undefined;
  const version = typeof descriptor.version === "string" &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(descriptor.version)
    ? descriptor.version
    : undefined;
  if (url === undefined || url !== descriptor.url || version === undefined ||
    password === undefined || password.length < 8 || password.length > 512) {
    return undefined;
  }
  return { url, password, version };
}

async function canAccessOpenCodeServer(
  server: string,
  password = process.env.OPENCODE_SERVER_PASSWORD,
): Promise<boolean> {
  return await probeOpenCodeServerVersion(server, "v2", password) !== undefined;
}

async function probeOpenCodeServerVersion(
  server: string,
  dialect: OpenCodeDialect,
  password?: string,
): Promise<string | undefined> {
  try {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    const authorization = password === undefined
      ? undefined
      : `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    const response = await fetch(new URL(
      dialect === "v1" ? "/global/health" : "/api/info",
      server,
    ), {
      headers: authorization ? { authorization } : {},
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    if (response.status !== 200) return undefined;
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object") return undefined;
    if (dialect === "v1" && (body as { healthy?: unknown }).healthy !== true) return undefined;
    const version = parseOpenCodeVersion((body as { version?: unknown }).version);
    return openCodeDialectForVersion(version) === dialect ? version ?? undefined : undefined;
  } catch {
    return undefined;
  }
}

async function canAccessOpenCodeServerV1(server: string, password?: string): Promise<boolean> {
  return await probeOpenCodeServerVersion(server, "v1", password) !== undefined;
}

async function discoverOpenCodeService(): Promise<OpenCodeServiceDescriptor | undefined> {
  const roots = [
    process.env.XDG_STATE_HOME,
    path.join(os.homedir(), ".local", "state"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const root of [...new Set(roots.map((value) => path.resolve(value)))]) {
    const filename = path.join(root, "opencode", "service.json");
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        stat.size <= 0 || stat.size > 16 * 1024) continue;
      const descriptor = parseOpenCodeServiceDescriptor(
        JSON.parse(await fs.readFile(filename, "utf8")),
      );
      if (descriptor &&
        await probeOpenCodeServerVersion(descriptor.url, "v2", descriptor.password) ===
          descriptor.version) {
        return descriptor;
      }
    } catch {
      // Missing, stale or malformed descriptors are ignored.
    }
  }
  return undefined;
}

type ActiveOpenCodeService = {
  dialect: OpenCodeDialect;
  version: string;
  url: string;
  password?: string;
};

async function discoverActiveOpenCodeServices(
  configuredServer?: string,
): Promise<ActiveOpenCodeService[]> {
  const services: ActiveOpenCodeService[] = [];
  const add = (service: ActiveOpenCodeService) => {
    if (!services.some((item) => item.dialect === service.dialect && item.url === service.url)) {
      services.push(service);
    }
  };
  if (!configuredServer) {
    const descriptor = await discoverOpenCodeService();
    if (descriptor && openCodeDialectForVersion(descriptor.version) === "v2") {
      add({
        dialect: "v2",
        version: descriptor.version,
        url: descriptor.url,
        password: descriptor.password,
      });
    }
  }
  const server = configuredServer ?? "http://127.0.0.1:4096";
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  for (const dialect of ["v1", "v2"] as const) {
    const version = await probeOpenCodeServerVersion(server, dialect, password);
    if (version) add({ dialect, version, url: server, ...(password ? { password } : {}) });
  }
  return services;
}

async function stopManagedServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(2_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

export function createManagedOpenCodeEnvironment(
  stateDirectory: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnvironment };
  env.XDG_STATE_HOME = stateDirectory;
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
  env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  delete env.OPENCODE_SERVER_PASSWORD;
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_PASSWORD;
  delete env.OPENCODE_USERNAME;
  return env;
}

export type ManagedOpenCodeServer = {
  url: string;
  password: string;
  close(): Promise<void>;
};

/** v1 reports its version only over `/global/health`, and prints its URL on stdout. */
async function startManagedV1Server(binary: string): Promise<ManagedOpenCodeServer> {
  const temporaryParent = path.join(process.cwd(), "tmp");
  await fs.mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  const stateDirectory = await fs.mkdtemp(path.join(temporaryParent, "opencode-state-"));
  const password = randomBytes(32).toString("hex");
  const env: NodeJS.ProcessEnv = {
    ...createManagedOpenCodeEnvironment(stateDirectory),
    OPENCODE_SERVER_PASSWORD: password,
    NO_COLOR: "1",
  };
  const child = spawn(binary, [
    "serve", "--hostname", "127.0.0.1", "--port", "0",
  ], {
    cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let printed = "";
  let failed = false;
  child.once("error", () => { failed = true; });
  child.stdout?.on("data", (chunk: Buffer) => { printed += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { printed += chunk.toString(); });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failed || child.exitCode !== null || child.signalCode !== null) break;
      const url = localServerUrl(printed);
      if (url && await canAccessOpenCodeServerV1(url, password)) {
        return {
          url,
          password,
          async close() {
            await stopManagedServer(child);
            await fs.rm(stateDirectory, { recursive: true, force: true });
          },
        };
      }
      await delay(100);
    }
  } catch {
    // Fall through to the contained startup error.
  }
  await stopManagedServer(child);
  await fs.rm(stateDirectory, { recursive: true, force: true });
  throw new Error("OPENCODE_SERVER_START_FAILED");
}

async function startManagedOpenCodeServer(
  binary: string,
  dialect: OpenCodeDialect,
): Promise<ManagedOpenCodeServer> {
  if (dialect === "v1") return startManagedV1Server(binary);
  const temporaryParent = path.join(process.cwd(), "tmp");
  await fs.mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  const stateDirectory = await fs.mkdtemp(path.join(temporaryParent, "opencode-state-"));
  const env = createManagedOpenCodeEnvironment(stateDirectory);
  const child = spawn(binary, [
    "serve", "--hostname", "127.0.0.1",
    "--port", "0", "--service",
  ], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let failed = false;
  child.once("error", () => { failed = true; });
  try {
    const descriptorFile = path.join(stateDirectory, "opencode", "service.json");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failed || child.exitCode !== null || child.signalCode !== null) break;
      try {
        const descriptor: unknown = JSON.parse(await fs.readFile(descriptorFile, "utf8"));
        const service = parseOpenCodeServiceDescriptor(descriptor);
        if (service && openCodeDialectForVersion(service.version) === "v2" &&
          await canAccessOpenCodeServer(service.url, service.password)) {
          return {
            url: service.url,
            password: service.password,
            async close() {
              await stopManagedServer(child);
              await fs.rm(stateDirectory, { recursive: true, force: true });
            },
          };
        }
      } catch {
        // The descriptor is created atomically after the service starts.
      }
      await delay(100);
    }
  } catch {
    // Fall through to the contained startup error.
  }
  await stopManagedServer(child);
  await fs.rm(stateDirectory, { recursive: true, force: true });
  throw new Error("OPENCODE_SERVER_START_FAILED");
}

async function runCli(
  args: string[],
  cliPath: string,
  server: string,
  password?: string,
): Promise<CliRunResult> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(password ? { OPENCODE_SERVER_PASSWORD: password } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outputText = "";
  child.stdout.on("data", (chunk: Buffer) => { outputText += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { outputText += chunk.toString(); });
  const code = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code === 0) return { ok: true, code: "", outputText };
  printFailure(outputText, server);
  return { ok: false, code: friendlyCode(outputText), outputText };
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function discoverWorkbenches(cdp: string): Promise<WorkbenchTarget[]> {
  const value = await readJson(`${cdp}/json/list`);
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object" &&
      item.type === "page" && typeof item.id === "string" &&
      typeof item.url === "string" && WORKBENCH_URL.test(item.url))
    .map((item) => ({
      id: item.id as string,
      title: typeof item.title === "string" && item.title.trim()
        ? item.title.replace(/\s+/g, " ").trim()
        : "未命名 workbench",
      url: item.url as string,
    }));
}

async function chooseWorkbench(cdp: string): Promise<WorkbenchTarget> {
  const targets = await discoverWorkbenches(cdp);
  if (targets.length === 0) {
    throw new Error("TRAE_DEBUG_PORT_UNAVAILABLE");
  }
  const requested = process.env.T2O_TRAE_CDP_TARGET;
  if (requested) {
    const target = targets.find((item) => item.id === requested);
    if (!target) throw new Error("TRAE_DEBUG_TARGET_NOT_FOUND");
    console.log(`已选择 workbench：${target.title}`);
    return target;
  }
  if (targets.length === 1) {
    console.log(`已发现 workbench：${targets[0].title}`);
    return targets[0];
  }
  console.log("\n发现多个 TRAE workbench，请选择：");
  targets.forEach((target, index) => {
    console.log(`  ${index + 1}. ${target.title}`);
  });
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("请输入 workbench 编号：");
    const index = parseChoiceIndex(answer, targets.length);
    if (index === undefined) throw new Error("TRAE_DEBUG_TARGET_INVALID");
    return targets[index];
  } finally {
    rl.close();
  }
}

function formatUpdatedAt(value?: number): string {
  if (value === undefined) return "更新时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "更新时间未知"
    : date.toLocaleString("zh-CN", { hour12: false });
}

async function chooseSessions(
  target: WorkbenchTarget,
  cdp: string,
): Promise<SessionChoice[]> {
  const transport = await connectTraeRuntime(cdp, target.id);
  try {
    const reader = createTraeRuntimeReader(transport);
    if (!transport.workspaceStorageId) throw new Error("TRAE_WORKSPACE_ID_UNAVAILABLE");
    const records = await reader.readSessionList();
    const runtimeReport = parseTraeRuntimeSessionMetadata(
      { items: records },
      transport.productVersion,
    );
    const choices = buildSessionChoices(runtimeReport.sessions, records);
    if (choices.length === 0) throw new Error("TRAE_WORKSPACE_SESSIONS_EMPTY");
    const requested = process.env.T2O_TRAE_SESSION;
    if (requested) {
      const requestedIds = [...new Set(requested.split(",").map((id) => id.trim()).filter(Boolean))];
      const selected = requestedIds.map((id) => choices.find((choice) => choice.id === id));
      if (selected.length === 0 || selected.some((choice) => choice === undefined)) {
        throw new Error("TRAE_SESSION_NOT_FOUND");
      }
      console.log(`已选择 ${selected.length} 个会话。`);
      return selected as SessionChoice[];
    }
    console.log("\n请选择要迁移的 TRAE 会话（支持多选）：");
    choices.forEach((choice, index) => {
      console.log(
        `  ${index + 1}. ${choice.title} · ${choice.metadataStatus} · ${formatUpdatedAt(choice.updatedAt)}`,
      );
    });
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question("请输入编号（如 1,3-5；输入 all 全选）：");
      const indexes = parseChoiceIndexes(answer, choices.length);
      if (!indexes) throw new Error("TRAE_SESSION_INVALID");
      return indexes.map((index) => choices[index]);
    } finally {
      rl.close();
    }
  } finally {
    transport.close();
  }
}

function targetSourceLabel(source: OpenCodeTargetCandidate["source"]): string {
  if (source === "desktop") return "桌面端内置 CLI";
  if (source === "configured") return "指定 CLI";
  return "PATH CLI";
}

async function chooseOpenCodeTargets(
  candidates: readonly OpenCodeTargetCandidate[],
): Promise<OpenCodeTargetCandidate[]> {
  if (candidates.length === 0) throw new Error("OPENCODE_TARGET_UNAVAILABLE");
  const requested = requestedOpenCodeTargets(process.env.T2O_OPENCODE_TARGETS, candidates);
  if (requested) {
    console.log(`已选择 OpenCode 目标：${requested.map((item) => item.dialect).join("、")}。`);
    return requested;
  }
  if (candidates.length === 1) {
    const candidate = candidates[0];
    console.log(`已发现 OpenCode ${candidate.version}（${candidate.dialect}）。`);
    return [candidate];
  }
  console.log("\n发现多个 OpenCode 目标，请选择（支持多选）：");
  candidates.forEach((candidate, index) => {
    console.log(
      `  ${index + 1}. OpenCode ${candidate.version} · ${candidate.dialect} · ` +
      targetSourceLabel(candidate.source),
    );
  });
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("请输入编号（如 1,2；输入 all 全选）：");
    const indexes = parseChoiceIndexes(answer, candidates.length);
    if (!indexes) throw new Error("OPENCODE_TARGET_SELECTION_INVALID");
    return indexes.map((index) => candidates[index]);
  } finally {
    rl.close();
  }
}

type SessionMigrationJob = {
  session: SessionChoice;
  directories: MigrationDirectories;
  replacementManifest?: string;
  resumeNeedsExclusiveAccess: boolean;
};

export function requiresOverwriteApproval(job: {
  replacementManifest?: string;
  resumeNeedsExclusiveAccess: boolean;
}): boolean {
  return job.replacementManifest !== undefined || job.resumeNeedsExclusiveAccess;
}

async function createSessionMigrationJob(
  rootDirectory: string,
  session: SessionChoice,
  targetDialect: OpenCodeDialect,
): Promise<SessionMigrationJob> {
  let directories = resolveMigrationDirectories(
    rootDirectory,
    session.id,
    process.env.T2O_MIGRATION_EXPORT,
    process.env.T2O_MIGRATION_RUN,
    session.updatedAt,
    targetDialect,
  );
  if (process.env.T2O_MIGRATION_RUN === undefined) {
    const legacy = resolveMigrationDirectories(
      rootDirectory,
      session.id,
      process.env.T2O_MIGRATION_EXPORT,
      undefined,
      session.updatedAt,
    );
    const legacyManifest = await readManifest(
      path.join(legacy.runDirectory, "migration-manifest.json"),
    ).catch(() => undefined);
    if (legacyManifest &&
      openCodeDialectForVersion(legacyManifest.target.serverVersion) === targetDialect) {
      directories = { ...directories, runDirectory: legacy.runDirectory };
    }
  }
  const manifestFile = path.join(directories.runDirectory, "migration-manifest.json");
  const manifestStat = await fs.stat(manifestFile).catch(() => undefined);
  let resumeNeedsExclusiveAccess = false;
  if (manifestStat?.isFile()) {
    const manifest = await readManifest(manifestFile).catch(() => undefined);
    resumeNeedsExclusiveAccess = manifest !== undefined &&
      replacementResumeNeedsExclusiveAccess(manifest);
  }
  const replacementManifest = manifestStat === undefined &&
      process.env.T2O_MIGRATION_RUN === undefined
    ? await findReplacementManifest({
        sourceSessionId: session.id,
        runRoot: path.dirname(directories.runDirectory),
        currentRunDirectory: directories.runDirectory,
        targetDialect,
      })
    : undefined;
  return {
    session,
    directories,
    ...(replacementManifest ? { replacementManifest } : {}),
    resumeNeedsExclusiveAccess,
  };
}

async function confirmOverwrite(
  count: number,
  policy: Exclude<OverwritePolicy, "skip">,
): Promise<boolean> {
  if (count === 0) return true;
  console.log(
    `\n检测到 ${count} 个会话需要 OVERWRITE：当前导出与旧迁移记录不同。`,
  );
  console.log("OVERWRITE 会先验证旧目标的所有权、内容哈希和子会话；全部通过后才删除旧目标并导入当前版本。");
  console.log("请先暂停其他 OpenCode 写入操作；任何安全检查失败都不会删除会话。");
  if (policy === "overwrite") {
    console.log("-y：已自动确认 OVERWRITE，开始执行安全检查。");
    return true;
  }
  const rl = createInterface({ input, output });
  try {
    return confirmsOverwrite(await rl.question("输入 OVERWRITE 确认删除旧目标并重新导入："));
  } finally {
    rl.close();
  }
}

async function migrateSelectedSession(options: {
  job: SessionMigrationJob;
  target: WorkbenchTarget;
  cdp: string;
  server: string;
  password?: string;
  rootDirectory: string;
  cliPath: string;
  binary: string;
  dialect: OpenCodeDialect;
  position: number;
  total: number;
  targetPosition: number;
  targetTotal: number;
}): Promise<boolean> {
  const {
    job, target, cdp, server, password, rootDirectory, cliPath, binary, dialect,
    position, total, targetPosition, targetTotal,
  } = options;
  const { session, directories } = job;
  const { exportDirectory, runDirectory } = directories;
  const inputFile = path.join(exportDirectory, "migration-bundle.json");
  const progress = targetTotal > 1
    ? `目标 ${targetPosition}/${targetTotal} · 会话 ${position}/${total}`
    : `${position}/${total}`;
  console.log(`\n[${progress}] 正在处理：${session.title}`);

  const existingBundle = await fs.stat(inputFile).catch(() => undefined);
  if (existingBundle) {
    if (!existingBundle.isFile()) {
      console.error("已有迁移 bundle 不是普通文件，已跳过该会话。");
      return false;
    }
    try {
      const bundle = await readBundleFile(inputFile);
      if (!bundleMatchesSession(bundle, session.id)) {
        console.error("已有迁移 bundle 与本次选择的会话不一致，已跳过该会话。");
        return false;
      }
    } catch {
      console.error("已有迁移 bundle 无法校验，已跳过该会话。");
      return false;
    }
    console.log("已发现并校验当前会话的迁移 bundle。");
  } else {
    await fs.mkdir(path.dirname(exportDirectory), { recursive: true, mode: 0o700 });
    if (!await prepareExportDirectory(exportDirectory)) {
      console.error("迁移导出目录已被其他文件占用，已跳过该会话。");
      return false;
    }
    console.log("正在导出所选会话...");
    const exported = await runCli([
      "export", "--cdp", cdp, "--cdp-target", target.id,
      "--session", session.id, "--output", exportDirectory,
      "--redact-credentials", "--json",
    ], cliPath, server);
    if (!exported.ok) return false;
    if (exported.outputText.includes("T2O_SENSITIVE_CONTENT_REDACTED")) {
      console.log("已自动将疑似凭据替换为脱敏占位符，该会话按部分恢复迁移。");
    }
  }

  const stat = await fs.stat(inputFile).catch(() => undefined);
  if (!stat || stat.size > MAX_BUNDLE_BYTES) {
    console.error(`迁移 bundle 超过 ${formatByteLimit(MAX_BUNDLE_BYTES)}，已跳过该会话。`);
    return false;
  }

  console.log("正在检查迁移完整性和 OpenCode 兼容性...");
  const preview = await runCli([
    "migrate", "--input", inputFile, "--dry-run", "--server", server,
    "--binary", binary, "--fallback-directory", rootDirectory, "--json",
  ], cliPath, server, password);
  if (!preview.ok) return false;
  const previewResult = cliJsonResult(preview.outputText);
  if (previewResult?.ready !== 1 || previewResult.blocked !== 0 ||
    previewResult.excluded !== 0) {
    console.error("所选会话包含当前无法无损映射的内容，未写入 OpenCode。");
    return false;
  }

  await fs.mkdir(path.dirname(runDirectory), { recursive: true, mode: 0o700 });
  const manifest = path.join(runDirectory, "migration-manifest.json");
  const manifestStat = await fs.stat(manifest).catch(() => undefined);
  const runDirectoryStat = await fs.stat(runDirectory).catch(() => undefined);
  const releasedEmptyRunDirectory = manifestStat === undefined &&
    runDirectoryStat !== undefined &&
    await prepareRunDirectory(runDirectory);
  const mode = resolveInteractiveMigrationMode({
    manifest,
    runDirectory,
    manifestExists: manifestStat !== undefined,
    runDirectoryExists: runDirectoryStat !== undefined && !releasedEmptyRunDirectory,
    replacementManifest: job.replacementManifest,
    resumeNeedsExclusiveAccess: job.resumeNeedsExclusiveAccess,
  });
  if (!mode) {
    console.error("迁移目录已存在但没有 manifest，已跳过该会话。");
    return false;
  }

  console.log(migrationProgressMessage(mode.name));
  const migrated = await runCli([
    "migrate", "--input", inputFile, "--server", server,
    "--binary", binary, "--fallback-directory", rootDirectory, ...mode.args, "--json",
  ], cliPath, server, password);
  if (!migrated.ok) return false;
  const migrationResult = cliJsonResult(migrated.outputText);
  if (migrationResult?.skipped === 1 && migrationResult.created === 0 &&
    migrationResult.replaced === 0) {
    console.error("目标会话已存在，但缺少可验证的旧 manifest，未执行覆盖。");
    return false;
  }
  if (migrationResult?.hasFailures !== false || migrationResult.verified !== 1) {
    console.error("迁移结果未通过完整回读校验。");
    return false;
  }
  console.log(migrationCompletionMessage(mode.name, runDirectory));

  const canCleanDefaultArtifacts =
    process.env.T2O_MIGRATION_EXPORT === undefined &&
    process.env.T2O_MIGRATION_RUN === undefined;
  if (canCleanDefaultArtifacts) {
    const cleaned = await cleanupObsoleteArtifacts({
      sourceSessionId: session.id,
      exportRoot: path.dirname(exportDirectory),
      runRoot: path.dirname(runDirectory),
      currentExportDirectory: exportDirectory,
      currentRunDirectory: runDirectory,
      targetDialect: dialect,
    });
    const totalCleaned = cleaned.exportDirectories + cleaned.runDirectories;
    if (totalCleaned > 0) {
      console.log(`已清理 ${totalCleaned} 个过期迁移目录，保留当前 bundle 和 manifest。`);
    }
  }
  return true;
}

type OpenCodeTargetRunResult = {
  candidate: OpenCodeTargetCandidate;
  completed: number;
  failed: number;
  skipped: number;
};

async function runOpenCodeTarget(options: {
  candidate: OpenCodeTargetCandidate;
  activeServices: readonly ActiveOpenCodeService[];
  configuredServer?: string;
  sessions: readonly SessionChoice[];
  workbench: WorkbenchTarget;
  cdp: string;
  rootDirectory: string;
  cliPath: string;
  overwritePolicy: OverwritePolicy;
  targetPosition: number;
  targetTotal: number;
}): Promise<OpenCodeTargetRunResult> {
  const {
    candidate, activeServices, configuredServer, sessions, workbench, cdp,
    rootDirectory, cliPath, overwritePolicy, targetPosition, targetTotal,
  } = options;
  let managedServer: ManagedOpenCodeServer | undefined;
  const active = activeServices.find((service) =>
    service.dialect === candidate.dialect && service.version === candidate.version) ??
    activeServices.find((service) => service.dialect === candidate.dialect);
  let server = configuredServer ?? active?.url;
  let password = configuredServer ? process.env.OPENCODE_SERVER_PASSWORD : active?.password;
  console.log(
    `\n=== OpenCode ${candidate.version}（${candidate.dialect}）` +
    `目标 ${targetPosition}/${targetTotal} ===`,
  );
  try {
    if (!server) {
      console.log("未发现该目标的本机服务，正在使用对应 CLI 临时启动...");
      try {
        managedServer = await startManagedOpenCodeServer(candidate.binary, candidate.dialect);
        server = managedServer.url;
        password = managedServer.password;
      } catch {
        console.error(
          `无法启动 OpenCode ${candidate.version}（${candidate.dialect}）目标；` +
          "请确认对应 CLI 可执行 serve。",
        );
        return { candidate, completed: 0, failed: sessions.length, skipped: 0 };
      }
    } else {
      console.log(`已连接 OpenCode ${active?.version ?? candidate.version} 本机服务。`);
    }

    const transport = createOpenCodeTransport({
      serverUrl: server,
      password,
      binary: candidate.binary,
    });
    console.log("正在检查目标协议；未收录版本会自动执行隔离往返验证...");
    const capabilities = await probeOpenCodeCapabilities(transport);
    if (!capabilities.writable || capabilities.dialect !== candidate.dialect) {
      printFailure(JSON.stringify({ code: capabilities.reasons[0] }), server);
      return { candidate, completed: 0, failed: sessions.length, skipped: 0 };
    }
    console.log(capabilities.compatibility === "isolated-roundtrip"
      ? `OpenCode ${capabilities.serverVersion} 兼容性检测通过（协议及隔离往返）。`
      : `OpenCode ${capabilities.serverVersion} 已验证版本，协议检查通过。`);

    const jobs = await Promise.all(
      sessions.map((session) =>
        createSessionMigrationJob(rootDirectory, session, candidate.dialect)),
    );
    const migrationTarget = createMigrationTarget({
      serverUrl: server, password, binary: candidate.binary, transport,
    });
    for (const job of jobs) {
      if (!job.replacementManifest) continue;
      try {
        const exists = await replacementTargetExists(
          job.replacementManifest,
          (targetId) => migrationTarget.readSession(targetId),
        );
        if (!exists) delete job.replacementManifest;
      } catch {
        console.error("无法核对已有目标会话，已停止该目标以保护 OpenCode 数据。");
        return { candidate, completed: 0, failed: sessions.length, skipped: 0 };
      }
    }

    const overwriteCount = jobs.filter(requiresOverwriteApproval).length;
    const skipped = overwritePolicy === "skip" ? overwriteCount : 0;
    const migrationJobs = overwritePolicy === "skip"
      ? jobs.filter((job) => !requiresOverwriteApproval(job))
      : jobs;
    if (overwritePolicy === "skip") {
      console.log(skipped > 0
        ? `-n：已跳过该目标中 ${skipped} 个需要 OVERWRITE 的会话；其余会话继续处理。`
        : "-n：该目标没有会话需要 OVERWRITE；新会话正常迁移，已有 manifest 执行续跑或回读校验。");
    }
    if (overwritePolicy !== "skip" &&
      !await confirmOverwrite(overwriteCount, overwritePolicy)) {
      console.error("未确认 OVERWRITE，未向该 OpenCode 目标写入任何会话。");
      return { candidate, completed: 0, failed: migrationJobs.length, skipped };
    }

    let completed = 0;
    for (const [index, job] of migrationJobs.entries()) {
      const succeeded = await migrateSelectedSession({
        job,
        target: workbench,
        cdp,
        server,
        password,
        rootDirectory,
        cliPath,
        binary: candidate.binary,
        dialect: candidate.dialect,
        position: index + 1,
        total: migrationJobs.length,
        targetPosition,
        targetTotal,
      });
      if (succeeded) completed++;
    }
    return {
      candidate,
      completed,
      failed: migrationJobs.length - completed,
      skipped,
    };
  } finally {
    await managedServer?.close();
  }
}

async function main(): Promise<number> {
  const overwritePolicy = resolveOverwritePolicy(
    process.argv.slice(2),
    process.env.npm_config_yes,
    process.env.T2O_REPLACE_EXISTING,
  );
  if (!overwritePolicy) {
    console.error("参数无效：仅支持 -y（自动覆盖）或 -n（自动跳过需要覆盖的会话），且不能同时使用。");
    return 4;
  }
  const cdp = process.env.T2O_TRAE_CDP ?? "http://127.0.0.1:9222";
  const rootDirectory = process.cwd();
  const cliPath = fileURLToPath(new URL("./index.js", import.meta.url));

  console.log("正在准备迁移工具...");
  let target: WorkbenchTarget;
  try {
    target = await chooseWorkbench(cdp);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "TRAE_DEBUG_TARGET_NOT_FOUND") {
      console.error("指定的 workbench 已不存在，请重新运行并选择当前窗口。");
    } else if (code === "TRAE_DEBUG_TARGET_INVALID") {
      console.error("workbench 编号无效，请重新运行。");
    } else {
      console.error("无法发现 TRAE workbench，请确认 TRAE 已开启本机调试端口。");
    }
    return 4;
  }

  let sessions: SessionChoice[];
  try {
    sessions = await chooseSessions(target, cdp);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "TRAE_SESSION_NOT_FOUND") {
      console.error("至少一个指定会话已不存在，请重新运行并选择当前会话。");
    } else if (code === "TRAE_SESSION_INVALID") {
      console.error("会话编号或范围无效，请重新运行。");
    } else if (code === "TRAE_WORKSPACE_SESSIONS_EMPTY") {
      console.error("所选 workbench 没有可迁移的本地会话。");
    } else {
      console.error("无法读取 TRAE 会话列表，请确认当前窗口已登录并可查看历史。");
    }
    return 4;
  }

  const configuredServer = process.env.T2O_OPENCODE_SERVER;
  const activeServices = await discoverActiveOpenCodeServices(configuredServer);
  let candidates: OpenCodeTargetCandidate[];
  try {
    const discovered = await discoverOpenCodeTargets();
    const activeVersions = Object.fromEntries(
      activeServices.map((service) => [service.dialect, service.version]),
    ) as Partial<Record<OpenCodeDialect, string>>;
    candidates = preferredOpenCodeTargets(discovered, activeVersions);
  } catch {
    console.error(
      `无法识别配置的 OpenCode 可执行文件。已验证版本：${VERIFIED_OPENCODE_VERSIONS.join(" / ")}；` +
      "可分别用 T2O_OPENCODE_V1_BINARY / T2O_OPENCODE_V2_BINARY 指定。",
    );
    return 4;
  }

  let openCodeTargets: OpenCodeTargetCandidate[];
  try {
    openCodeTargets = await chooseOpenCodeTargets(candidates);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    console.error(code === "OPENCODE_TARGET_UNAVAILABLE"
      ? "没有发现可用的 OpenCode v1/v2 CLI；请安装后重试，或分别指定目标 CLI。"
      : "OpenCode 目标选择无效，或请求的 v1/v2 目标不可用。");
    return 4;
  }

  const usesCustomArtifacts =
    process.env.T2O_MIGRATION_EXPORT !== undefined ||
    process.env.T2O_MIGRATION_RUN !== undefined;
  if (sessions.length > 1 && usesCustomArtifacts) {
    console.error("多选迁移不能共用自定义 bundle 或 manifest 路径，请取消路径覆盖后重试。");
    return 4;
  }
  if (openCodeTargets.length > 1 && process.env.T2O_MIGRATION_RUN !== undefined) {
    console.error("多目标迁移不能共用 T2O_MIGRATION_RUN；请使用默认的目标隔离记录目录。");
    return 4;
  }
  if (openCodeTargets.length > 1 && configuredServer !== undefined) {
    console.error("T2O_OPENCODE_SERVER 只表示一个目标；多目标迁移请取消该设置并使用各目标 CLI。");
    return 4;
  }

  const results: OpenCodeTargetRunResult[] = [];
  for (const [index, candidate] of openCodeTargets.entries()) {
    results.push(await runOpenCodeTarget({
      candidate,
      activeServices,
      configuredServer,
      sessions,
      workbench: target,
      cdp,
      rootDirectory,
      cliPath,
      overwritePolicy,
      targetPosition: index + 1,
      targetTotal: openCodeTargets.length,
    }));
  }
  if (openCodeTargets.length > 1) {
    console.log("\n多目标迁移完成：");
    for (const result of results) {
      const skipped = result.skipped ? `，跳过 ${result.skipped} 个` : "";
      console.log(
        `  OpenCode ${result.candidate.version}（${result.candidate.dialect}）：` +
        `成功 ${result.completed} 个，失败 ${result.failed} 个${skipped}`,
      );
    }
  }
  return results.every((result) => result.failed === 0) ? 0 : 4;
}

const isMainModule = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().then((code) => { process.exitCode = code; });
}
