import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { connectTraeRuntime } from "../source/trae/runtime-cdp.js";
import { createTraeRuntimeReader } from "../source/trae/runtime-reader.js";
import {
  parseTraeRuntimeSessionMetadata,
  type TraeSessionMetadata,
} from "../source/trae/session-metadata.js";
import { OPENCODE_VERSION } from "../target/opencode/contract.js";

const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const INTERACTIVE_EXPORT_REVISION = 9;
const MANAGED_OPENCODE_PORT = 4097;
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

function selectionKey(sourceSessionId: string, sourceUpdatedAt?: number): string {
  return createHash("sha256")
    .update(JSON.stringify([
      INTERACTIVE_EXPORT_REVISION,
      sourceSessionId,
      sourceUpdatedAt ?? null,
    ]))
    .digest("hex")
    .slice(0, 16);
}

export function resolveMigrationDirectories(
  rootDirectory: string,
  sourceSessionId: string,
  exportOverride?: string,
  runOverride?: string,
  sourceUpdatedAt?: number,
): MigrationDirectories {
  const exportRoot = path.resolve(exportOverride ?? path.join(rootDirectory, "trae-export"));
  const runRoot = path.resolve(runOverride ?? path.join(rootDirectory, "migration-run"));
  const hasExportOverride = exportOverride !== undefined;
  const hasRunOverride = runOverride !== undefined;
  const key = `session-${selectionKey(sourceSessionId, sourceUpdatedAt)}`;
  return {
    exportDirectory: hasExportOverride ? exportRoot : path.join(exportRoot, key),
    runDirectory: hasRunOverride ? runRoot : path.join(runRoot, key),
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
): boolean {
  const session = manifest.sessions[0];
  return manifest.rollbackState === undefined &&
    manifest.sessions.length === 1 &&
    session.sourceId === sourceSessionId &&
    session.state === "verified" &&
    session.created &&
    session.deletionHash !== undefined;
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

export type InteractiveMigrationMode = {
  name: "create" | "replace" | "resume";
  args: string[];
};

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
      if (!isReplacementManifestForSession(manifest, options.sourceSessionId)) continue;
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
    case "T2O_OPENCODE_SCHEMA_UNSUPPORTED":
      console.error("OpenCode 版本或协议不受支持，需要经过验证的 2.0.12。");
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
  try {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    const authorization = password === undefined
      ? undefined
      : `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    const response = await fetch(new URL("/api/info", server), {
      headers: authorization ? { authorization } : {},
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
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
      if (descriptor && await canAccessOpenCodeServer(descriptor.url, descriptor.password)) {
        return descriptor;
      }
    } catch {
      // Missing, stale or malformed descriptors are ignored.
    }
  }
  return undefined;
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

async function startManagedOpenCodeServer(): Promise<{
  url: string;
  password: string;
  close(): Promise<void>;
}> {
  const temporaryParent = path.join(process.cwd(), "tmp");
  await fs.mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  const stateDirectory = await fs.mkdtemp(path.join(temporaryParent, "opencode-state-"));
  const env = createManagedOpenCodeEnvironment(stateDirectory);
  const child = spawn("opencode", [
    "serve", "--hostname", "127.0.0.1",
    "--port", String(MANAGED_OPENCODE_PORT), "--service",
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
        if (service?.version === OPENCODE_VERSION &&
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

type SessionMigrationJob = {
  session: SessionChoice;
  directories: MigrationDirectories;
  replacementManifest?: string;
  resumeNeedsExclusiveAccess: boolean;
};

async function createSessionMigrationJob(
  rootDirectory: string,
  session: SessionChoice,
): Promise<SessionMigrationJob> {
  const directories = resolveMigrationDirectories(
    rootDirectory,
    session.id,
    process.env.T2O_MIGRATION_EXPORT,
    process.env.T2O_MIGRATION_RUN,
    session.updatedAt,
  );
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
      })
    : undefined;
  return {
    session,
    directories,
    ...(replacementManifest ? { replacementManifest } : {}),
    resumeNeedsExclusiveAccess,
  };
}

async function confirmOverwrite(count: number): Promise<boolean> {
  if (count === 0 || process.env.T2O_REPLACE_EXISTING === "1") return true;
  console.log(
    `\n检测到 ${count} 个由本工具迁移的已有会话，将先校验内容未被修改，再覆盖为新版本。`,
  );
  console.log("请先暂停其他 OpenCode 写入操作；校验失败时不会删除任何会话。");
  const rl = createInterface({ input, output });
  try {
    return confirmsOverwrite(await rl.question("输入 OVERWRITE 确认覆盖："));
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
  position: number;
  total: number;
}): Promise<boolean> {
  const { job, target, cdp, server, password, rootDirectory, cliPath, position, total } = options;
  const { session, directories } = job;
  const { exportDirectory, runDirectory } = directories;
  const inputFile = path.join(exportDirectory, "migration-bundle.json");
  console.log(`\n[${position}/${total}] 正在处理：${session.title}`);

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
    console.error("迁移 bundle 超过 128 MiB，已跳过该会话。");
    return false;
  }

  console.log("正在检查迁移完整性和 OpenCode 兼容性...");
  const preview = await runCli([
    "migrate", "--input", inputFile, "--dry-run", "--server", server,
    "--fallback-directory", rootDirectory, "--json",
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

  console.log(mode.name === "replace"
    ? "正在校验并覆盖已有会话，请稍候..."
    : "正在迁移并校验，请稍候...");
  const migrated = await runCli([
    "migrate", "--input", inputFile, "--server", server,
    "--fallback-directory", rootDirectory, ...mode.args, "--json",
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
  if (migrationResult.replaced === 1) {
    console.log("已有会话已安全覆盖并通过校验。");
  } else if (mode.name === "resume") {
    console.log("迁移续跑完成，已有会话已校验。");
  } else {
    console.log(`迁移完成，结果已写入：${runDirectory}`);
  }

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
    });
    const totalCleaned = cleaned.exportDirectories + cleaned.runDirectories;
    if (totalCleaned > 0) {
      console.log(`已清理 ${totalCleaned} 个过期迁移目录，保留当前 bundle 和 manifest。`);
    }
  }
  return true;
}

async function main(): Promise<number> {
  const cdp = process.env.T2O_TRAE_CDP ?? "http://127.0.0.1:9222";
  let server = process.env.T2O_OPENCODE_SERVER ?? "http://127.0.0.1:4096";
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

  const usesCustomArtifacts =
    process.env.T2O_MIGRATION_EXPORT !== undefined ||
    process.env.T2O_MIGRATION_RUN !== undefined;
  if (sessions.length > 1 && usesCustomArtifacts) {
    console.error("多选迁移不能共用自定义 bundle 或 manifest 路径，请取消路径覆盖后重试。");
    return 4;
  }

  const jobs = await Promise.all(
    sessions.map((session) => createSessionMigrationJob(rootDirectory, session)),
  );

  let managedServer: Awaited<ReturnType<typeof startManagedOpenCodeServer>> | undefined;
  let serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
  try {
    if (!process.env.T2O_OPENCODE_SERVER) {
      const discovered = await discoverOpenCodeService();
      if (discovered) {
        if (discovered.version !== OPENCODE_VERSION) {
          console.error(
            `检测到正在运行的 OpenCode ${discovered.version}，当前仅支持 ${OPENCODE_VERSION}。` +
            "请完全退出 OpenCode 桌面端或停止该服务后重试。",
          );
          return 4;
        }
        server = discovered.url;
        serverPassword = discovered.password;
        console.log("已连接当前 OpenCode 2.0.12 本机服务。");
      } else if (!await canAccessOpenCodeServer(server, serverPassword)) {
        console.log("默认 OpenCode 服务不可访问，正在临时启动本机服务...");
        try {
          managedServer = await startManagedOpenCodeServer();
          server = managedServer.url;
          serverPassword = managedServer.password;
        } catch {
          console.error("无法自动启动 OpenCode，请确认已安装 2.0.12。");
          return 4;
        }
      }
    }

    const migrationTarget = createMigrationTarget({
      serverUrl: server,
      password: serverPassword,
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
        console.error("无法核对已有目标会话，已停止以保护 OpenCode 数据。");
        return 4;
      }
    }
    const overwriteCount = jobs.filter((job) =>
      job.replacementManifest !== undefined || job.resumeNeedsExclusiveAccess).length;
    if (!await confirmOverwrite(overwriteCount)) {
      console.error("未确认覆盖，未写入 OpenCode。");
      return 4;
    }

    let completed = 0;
    for (const [index, job] of jobs.entries()) {
      const succeeded = await migrateSelectedSession({
        job,
        target,
        cdp,
        server,
        password: serverPassword,
        rootDirectory,
        cliPath,
        position: index + 1,
        total: jobs.length,
      });
      if (succeeded) completed++;
    }
    if (jobs.length > 1) {
      console.log(`\n批量迁移完成：成功 ${completed} 个，失败 ${jobs.length - completed} 个。`);
    }
    return completed === jobs.length ? 0 : 4;
  } finally {
    await managedServer?.close();
  }
}

const isMainModule = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().then((code) => { process.exitCode = code; });
}
