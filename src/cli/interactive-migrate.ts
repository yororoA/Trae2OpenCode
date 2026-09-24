import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { detectTraeVersion } from "../source/trae/collect.js";
import { requireTraeRoot } from "../source/trae/path-discovery.js";
import { connectTraeRuntime } from "../source/trae/runtime-cdp.js";
import { createTraeRuntimeReader } from "../source/trae/runtime-reader.js";
import { readTraeSessionMetadata } from "../source/trae/session-metadata.js";

const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const WORKBENCH_URL =
  /\/out\/vs\/code\/electron-browser\/workbench\/workbench\.html(?:\?|$)/;

type WorkbenchTarget = {
  id: string;
  title: string;
  url: string;
};

type SessionChoice = {
  id: string;
  title: string;
  recovery: string;
  updatedAt?: number;
};

const RECOVERY_LABELS: Record<string, string> = {
  complete: "完整",
  partial: "部分可恢复",
  "metadata-only": "仅元数据",
  unrecoverable: "不可恢复",
};

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
    const index = Number.parseInt(answer.trim(), 10) - 1;
    if (!Number.isInteger(index) || !targets[index]) throw new Error("TRAE_DEBUG_TARGET_INVALID");
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
    const metadata = new Map(
      records
        .filter((record): record is Record<string, unknown> =>
          record !== null && typeof record === "object")
        .map((record) => [String(record.chat_session_id), record]),
    );
    const choices: SessionChoice[] = localReport.sessions.map((session) => {
      const record = metadata.get(session.sourceSessionId);
      return {
        id: session.sourceSessionId,
        title: typeof record?.title === "string" && record.title.trim()
          ? record.title.replace(/\s+/g, " ").trim()
          : "未命名会话",
        recovery: RECOVERY_LABELS[session.metadataStatus] ?? session.metadataStatus,
        updatedAt: typeof record?.updated_at === "string"
          ? Number(record.updated_at)
          : session.updatedAt,
      };
    });
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
        `  ${index + 1}. ${choice.title} · ${choice.recovery} · ${formatUpdatedAt(choice.updatedAt)}`,
      );
    });
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question("请输入会话编号：");
      const index = Number.parseInt(answer.trim(), 10) - 1;
      if (!Number.isInteger(index) || !choices[index]) throw new Error("TRAE_SESSION_INVALID");
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
  const exportDirectory = path.resolve(
    process.env.T2O_MIGRATION_EXPORT ?? path.join(rootDirectory, "trae-export"),
  );
  const runDirectory = path.resolve(
    process.env.T2O_MIGRATION_RUN ?? path.join(rootDirectory, "migration-run"),
  );
  const inputFile = path.join(exportDirectory, "migration-bundle.json");
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

  if (await fs.stat(inputFile).catch(() => undefined)) {
    console.log("已发现已有迁移 bundle。");
  } else {
    if (await fs.stat(exportDirectory).catch(() => undefined)) {
      console.error("导出目录已存在但没有 bundle，请更换目录后重试。");
      return 4;
    }
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

main().then((code) => { process.exitCode = code; });
