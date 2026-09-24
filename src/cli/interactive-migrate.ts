import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationBundle } from "../ir/types.js";
import { readBundleFile } from "../migration/bundle-file.js";
import { connectTraeRuntime } from "../source/trae/runtime-cdp.js";
import { createTraeRuntimeReader } from "../source/trae/runtime-reader.js";
import {
  parseTraeRuntimeSessionMetadata,
  type TraeSessionMetadata,
} from "../source/trae/session-metadata.js";
import { OPENCODE_VERSION } from "../target/opencode/contract.js";

const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const INTERACTIVE_EXPORT_REVISION = 6;
const MANAGED_OPENCODE_PORT = 4097;
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

async function stopManagedServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(2_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function startManagedOpenCodeServer(): Promise<{
  url: string;
  password: string;
  close(): Promise<void>;
}> {
  const temporaryParent = path.join(process.cwd(), "tmp");
  await fs.mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  const stateDirectory = await fs.mkdtemp(path.join(temporaryParent, "opencode-state-"));
  const env = { ...process.env };
  env.XDG_STATE_HOME = stateDirectory;
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
  env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  delete env.OPENCODE_SERVER_PASSWORD;
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_PASSWORD;
  delete env.OPENCODE_USERNAME;
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
        if (descriptor !== null && typeof descriptor === "object" && !Array.isArray(descriptor)) {
          const value = descriptor as Record<string, unknown>;
          const url = typeof value.url === "string" ? localServerUrl(value.url) : undefined;
          const password = typeof value.password === "string" ? value.password : undefined;
          if (typeof url === "string" && url === value.url && value.version === OPENCODE_VERSION &&
            password !== undefined && password.length >= 8 && password.length <= 512 &&
            await canAccessOpenCodeServer(url, password)) {
            return {
              url,
              password,
              async close() {
                await stopManagedServer(child);
                await fs.rm(stateDirectory, { recursive: true, force: true });
              },
            };
          }
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

async function chooseSession(
  target: WorkbenchTarget,
  cdp: string,
): Promise<SessionChoice> {
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
      const selected = choices.find((choice) => choice.id === requested);
      if (!selected) throw new Error("TRAE_SESSION_NOT_FOUND");
      console.log(`已选择会话：${selected.title}`);
      return selected;
    }
    console.log("\n请选择要迁移的 TRAE 会话：");
    choices.forEach((choice, index) => {
      console.log(
        `  ${index + 1}. ${choice.title} · ${choice.metadataStatus} · ${formatUpdatedAt(choice.updatedAt)}`,
      );
    });
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question("请输入会话编号：");
      const index = parseChoiceIndex(answer, choices.length);
      if (index === undefined) throw new Error("TRAE_SESSION_INVALID");
      return choices[index];
    } finally {
      rl.close();
    }
  } finally {
    transport.close();
  }
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

  let session: SessionChoice;
  try {
    session = await chooseSession(target, cdp);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "TRAE_SESSION_NOT_FOUND") {
      console.error("指定的会话已不存在，请重新运行并选择当前会话。");
    } else if (code === "TRAE_SESSION_INVALID") {
      console.error("会话编号无效，请重新运行。");
    } else if (code === "TRAE_WORKSPACE_SESSIONS_EMPTY") {
      console.error("所选 workbench 没有可迁移的本地会话。");
    } else {
      console.error("无法读取 TRAE 会话列表，请确认当前窗口已登录并可查看历史。");
    }
    return 4;
  }

  const directories = resolveMigrationDirectories(
    rootDirectory,
    session.id,
    process.env.T2O_MIGRATION_EXPORT,
    process.env.T2O_MIGRATION_RUN,
    session.updatedAt,
  );
  const exportDirectory = directories.exportDirectory;
  const runDirectory = directories.runDirectory;
  const inputFile = path.join(exportDirectory, "migration-bundle.json");
  const existingBundle = await fs.stat(inputFile).catch(() => undefined);
  if (existingBundle) {
    if (!existingBundle.isFile()) {
      console.error("已有迁移 bundle 不是普通文件，已停止以避免覆盖数据。");
      return 4;
    }
    try {
      const bundle = await readBundleFile(inputFile);
      if (!bundleMatchesSession(bundle, session.id)) {
        console.error("已有迁移 bundle 与本次选择的会话不一致，已停止以避免误迁移。");
        return 4;
      }
    } catch {
      console.error("已有迁移 bundle 无法校验，已停止以避免覆盖数据。");
      return 4;
    }
    console.log("已发现并校验当前会话的迁移 bundle。");
  } else {
    await fs.mkdir(path.dirname(exportDirectory), { recursive: true, mode: 0o700 });
    if (!await prepareExportDirectory(exportDirectory)) {
      console.error("迁移导出目录已被其他文件占用，已停止以避免覆盖数据。");
      return 4;
    }
    console.log("正在导出所选会话...");
    const exported = await runCli([
      "export", "--cdp", cdp, "--cdp-target", target.id,
      "--session", session.id, "--output", exportDirectory,
      "--redact-credentials", "--json",
    ], cliPath, server);
    if (!exported.ok) return 4;
    if (exported.outputText.includes("T2O_SENSITIVE_CONTENT_REDACTED")) {
      console.log("已自动将疑似凭据替换为脱敏占位符，该会话按部分恢复迁移。");
    }
  }

  const stat = await fs.stat(inputFile).catch(() => undefined);
  if (!stat || stat.size > MAX_BUNDLE_BYTES) {
    console.error("迁移 bundle 超过 128 MiB，请重新选择更小的会话。");
    return 4;
  }

  let managedServer: Awaited<ReturnType<typeof startManagedOpenCodeServer>> | undefined;
  try {
    if (!process.env.T2O_OPENCODE_SERVER && !await canAccessOpenCodeServer(server)) {
      console.log("默认 OpenCode 服务不可访问，正在临时启动本机服务...");
      try {
        managedServer = await startManagedOpenCodeServer();
        server = managedServer.url;
      } catch {
        console.error("无法自动启动 OpenCode，请确认已安装 2.0.12。");
        return 4;
      }
    }

    console.log("正在检查迁移完整性和 OpenCode 兼容性...");
    const preview = await runCli([
      "migrate", "--input", inputFile, "--dry-run", "--server", server,
      "--fallback-directory", rootDirectory, "--json",
    ], cliPath, server, managedServer?.password);
    if (!preview.ok) return 4;
    const previewResult = cliJsonResult(preview.outputText);
    if (previewResult?.ready !== 1 || previewResult.blocked !== 0 ||
      previewResult.excluded !== 0) {
      console.error("所选会话包含当前无法无损映射的内容，未写入 OpenCode。");
      return 4;
    }

    await fs.mkdir(path.dirname(runDirectory), { recursive: true, mode: 0o700 });
    const manifest = path.join(runDirectory, "migration-manifest.json");
    const mode = (await fs.stat(manifest).catch(() => undefined))
      ? ["--resume", manifest]
      : (await fs.stat(runDirectory).catch(() => undefined))
        ? null
        : ["--output", runDirectory];
    if (!mode) {
      console.error("迁移目录已存在但没有 manifest，请更换迁移目录后重试。");
      return 4;
    }

    console.log("正在迁移并校验，请稍候...");
    const migrated = await runCli([
      "migrate", "--input", inputFile, "--server", server,
      "--fallback-directory", rootDirectory, ...mode, "--json",
    ], cliPath, server, managedServer?.password);
    if (!migrated.ok) return 4;
    const migrationResult = cliJsonResult(migrated.outputText);
    if (migrationResult?.skipped === 1 && migrationResult.created === 0) {
      console.log("目标会话已存在，未重复导入。");
    } else {
      console.log(mode[0] === "--resume"
        ? "迁移续跑完成，已有会话已校验。"
        : `迁移完成，结果已写入：${runDirectory}`);
    }
    return 0;
  } finally {
    await managedServer?.close();
  }
}

const isMainModule = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().then((code) => { process.exitCode = code; });
}
