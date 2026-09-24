import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationBundle } from "../ir/types.js";
import { readBundleFile } from "../migration/bundle-file.js";
import { detectTraeVersion } from "../source/trae/collect.js";
import { requireTraeRoot } from "../source/trae/path-discovery.js";
import { connectTraeRuntime } from "../source/trae/runtime-cdp.js";
import { createTraeRuntimeReader } from "../source/trae/runtime-reader.js";
import {
  readTraeSessionMetadata,
  type TraeSessionMetadata,
} from "../source/trae/session-metadata.js";

const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
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

function selectionKey(sourceSessionId: string): string {
  return createHash("sha256").update(sourceSessionId).digest("hex").slice(0, 16);
}

export function resolveMigrationDirectories(
  rootDirectory: string,
  sourceSessionId: string,
  exportOverride?: string,
  runOverride?: string,
): MigrationDirectories {
  const exportRoot = path.resolve(exportOverride ?? path.join(rootDirectory, "trae-export"));
  const runRoot = path.resolve(runOverride ?? path.join(rootDirectory, "migration-run"));
  const hasExportOverride = exportOverride !== undefined;
  const hasRunOverride = runOverride !== undefined;
  const key = `session-${selectionKey(sourceSessionId)}`;
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
      console.error("检测到疑似凭据，已停止迁移。请移除凭据后重新导出。");
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
    default:
      console.error("迁移未完成，请检查 TRAE、OpenCode 和迁移目录。");
  }
}

async function runCli(args: string[], cliPath: string, server: string): Promise<boolean> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outputText = "";
  child.stdout.on("data", (chunk: Buffer) => { outputText += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { outputText += chunk.toString(); });
  const code = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code === 0) return true;
  printFailure(outputText, server);
  return false;
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
): Promise<string> {
  const root = requireTraeRoot();
  const productVersion = await detectTraeVersion();
  const localReport = await readTraeSessionMetadata({ root, productVersion });
  const transport = await connectTraeRuntime(cdp, target.id);
  try {
    const reader = createTraeRuntimeReader(transport);
    const records = await reader.readMetadata(
      localReport.sessions.map((session) => session.sourceSessionId),
    );
    const choices = buildSessionChoices(localReport.sessions, records);
    const requested = process.env.T2O_TRAE_SESSION;
    if (requested) {
      const selected = choices.find((choice) => choice.id === requested);
      if (!selected) throw new Error("TRAE_SESSION_NOT_FOUND");
      console.log(`已选择会话：${selected.title}`);
      return selected.id;
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
      return choices[index].id;
    } finally {
      rl.close();
    }
  } finally {
    transport.close();
  }
}

async function main(): Promise<number> {
  const cdp = process.env.T2O_TRAE_CDP ?? "http://127.0.0.1:9222";
  const server = process.env.T2O_OPENCODE_SERVER ?? "http://127.0.0.1:4096";
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

  let sessionId: string;
  try {
    sessionId = await chooseSession(target, cdp);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "TRAE_SESSION_NOT_FOUND") {
      console.error("指定的会话已不存在，请重新运行并选择当前会话。");
    } else if (code === "TRAE_SESSION_INVALID") {
      console.error("会话编号无效，请重新运行。");
    } else {
      console.error("无法读取 TRAE 会话列表，请确认当前窗口已登录并可查看历史。");
    }
    return 4;
  }

  const directories = resolveMigrationDirectories(
    rootDirectory,
    sessionId,
    process.env.T2O_MIGRATION_EXPORT,
    process.env.T2O_MIGRATION_RUN,
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
      if (!bundleMatchesSession(bundle, sessionId)) {
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
    console.log("正在导出所选会话...");
    const exported = await runCli([
      "export", "--cdp", cdp, "--cdp-target", target.id,
      "--session", sessionId, "--output", exportDirectory, "--json",
    ], cliPath, server);
    if (!exported) return 4;
  }

  const stat = await fs.stat(inputFile).catch(() => undefined);
  if (!stat || stat.size > MAX_BUNDLE_BYTES) {
    console.error("迁移 bundle 超过 128 MiB，请重新选择更小的会话。");
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
  ], cliPath, server);
  if (!migrated) return 4;
  console.log(mode[0] === "--resume"
    ? "迁移续跑完成，已有会话已校验。"
    : `迁移完成，结果已写入：${runDirectory}`);
  return 0;
}

const isMainModule = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().then((code) => { process.exitCode = code; });
}
