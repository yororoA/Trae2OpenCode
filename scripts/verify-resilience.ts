/** Bounded-heap migration workers, real native target, real OS process termination. */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantEventIR, MigrationBundle, ToolContentIR } from "../src/ir/types.js";
import { exportBundleFile, readBundleFile } from "../src/migration/bundle-file.js";
import { migrate, verifyMigration } from "../src/migration/executor.js";
import { readManifest, withManifestStore } from "../src/migration/manifest.js";
import { buildMigrationPlan } from "../src/migration/plan.js";
import { createMigrationTarget, type MigrationTarget } from "../src/migration/target.js";
import { withIsolatedOpenCodeServer } from "../src/target/opencode/isolated-server.js";

type Mode = "large" | "before-import" | "after-import";
type Request = { kind: "request"; id: number; method: "describe" | "read" | "import"; value?: unknown };
type WorkerReport = { kind: "complete"; mode: Mode; sessions: number; messages: number; sampledPeakRssBytes: number; heapBytes: number };
type Reply = { kind: "reply"; id: number; value: unknown } | WorkerReport;
const batchSize = 12;
const killAtImport = 4;
const heapMiB = 512;

async function syntheticBundle(mode: Mode): Promise<MigrationBundle> {
  const serialized = await fs.readFile("fixtures/ir/v1/valid-trae-assembled.json", "utf8");
  const bundle = JSON.parse(serialized) as MigrationBundle;
  const sessionCount = mode === "large" ? 1 : batchSize;
  bundle.sessions = [];
  for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex++) {
    const sourceId = `resilience-${mode}-${sessionIndex}`;
    const session = (JSON.parse(serialized.replaceAll("session-synthetic", sourceId)) as MigrationBundle).sessions[0];
    if (mode === "large") {
      const [user, assistant] = session.events;
      session.events = [];
      for (let index = 0; index < 1000; index++) {
        const pair = JSON.parse(JSON.stringify([user, assistant])
          .replaceAll("user-synthetic", `user-${index}`)
          .replaceAll("assistant-synthetic", `assistant-${index}`)) as typeof session.events;
        pair[0].order = index * 2 + 1;
        pair[1].order = index * 2 + 2;
        pair[0].createdAt = 1700000000000 + index * 5000;
        pair[1].createdAt = pair[0].createdAt + 1000;
        (pair[1] as AssistantEventIR).completedAt = pair[0].createdAt + 4000;
        if (pair[0].type === "user") pair[0].text = `Synthetic message ${index}: ` + "sample ".repeat(150);
        session.events.push(...pair);
      }
      const last = session.events.at(-1) as AssistantEventIR;
      const tool = last.content.find((block) => block.type === "tool") as ToolContentIR;
      tool.output = { text: "x".repeat(8 * 1024 * 1024) };
      session.updatedAt = last.completedAt;
    }
    bundle.sessions.push(session);
  }
  return bundle;
}

async function worker(): Promise<void> {
  const [, , modeArg, directory, resumeArg] = process.argv;
  const mode = modeArg as Mode;
  let sampledPeakRssBytes = process.memoryUsage().rss;
  const sampleMemory = () => { sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss); };
  const memoryTimer = setInterval(sampleMemory, 25);
  memoryTimer.unref();
  let requestId = 0;
  const pending = new Map<number, (value: unknown) => void>();
  process.on("message", (message: Reply) => {
    if (message.kind !== "reply") return;
    pending.get(message.id)?.(message.value);
    pending.delete(message.id);
  });
  const request = (method: Request["method"], value?: unknown) => new Promise<unknown>((resolve) => {
    sampleMemory();
    const id = ++requestId;
    pending.set(id, resolve);
    process.send!({ kind: "request", id, method, value });
  });
  // RPC only carries the synthetic target operations. Parent uses the production adapter.
  const target: MigrationTarget = {
    describe: async () => await request("describe") as Awaited<ReturnType<MigrationTarget["describe"]>>,
    readSession: async (id) => await request("read", id) as Awaited<ReturnType<MigrationTarget["readSession"]>>,
    importSession: async (transfer) => await request("import", transfer) as Awaited<ReturnType<MigrationTarget["importSession"]>>,
  };
  const input = await syntheticBundle(mode);
  const bundleDirectory = path.join(directory, `${mode}-bundle`);
  if (resumeArg !== "resume") await exportBundleFile(input, bundleDirectory);
  const bundle = await readBundleFile(path.join(bundleDirectory, "migration-bundle.json"));
  const plan = await buildMigrationPlan(bundle, { fallbackDirectory: directory, namespace: `stress-${mode}` });
  assert.ok(plan.sessions.every((session) => session.status === "ready"));
  const outputDirectory = path.join(directory, mode);
  const filename = path.join(outputDirectory, "migration-manifest.json");
  const result = await migrate(plan, target,
    resumeArg === "resume" ? { resumeManifest: filename } : { outputDirectory });
  assert.equal(result.hasFailures, false);
  assert.equal(result.verified, bundle.sessions.length);
  assert.equal(result.created, bundle.sessions.length);
  assert.equal((await verifyMigration(filename, target)).hasFailures, false);
  const repeat = await migrate(plan, target, { resumeManifest: filename });
  assert.equal(repeat.verified, bundle.sessions.length);
  assert.equal(repeat.hasFailures, false);
  const duplicate = await migrate(plan, target, { outputDirectory: path.join(directory, `${mode}-duplicate`) });
  assert.equal(duplicate.created, 0);
  assert.equal(duplicate.skipped, bundle.sessions.length);
  const manifest = await readManifest(filename);
  assert.ok(manifest.sessions.every((session) => session.attempts === 1 ||
    (mode === "before-import" && session.attempts === 2)));
  const report: WorkerReport = {
    kind: "complete", mode, sessions: bundle.sessions.length,
    messages: bundle.sessions.reduce((count, session) => count + session.events.length, 0),
    sampledPeakRssBytes, heapBytes: process.memoryUsage().heapUsed,
  };
  clearInterval(memoryTimer);
  process.send!(report);
  process.disconnect!();
}

async function parent(): Promise<void> {
  const binary = process.env.T2O_TEST_OPENCODE_BINARY;
  await withIsolatedOpenCodeServer({
    temporaryRoot: "tmp", ...(binary ? { binary: path.resolve(binary) } : {}),
  }, async (server) => {
    const target = createMigrationTarget({ ...server, temporaryRoot: server.directory });
    const reports: unknown[] = [];
    for (const mode of ["large", "before-import", "after-import"] as const) {
      const filename = path.join(server.directory, mode, "migration-manifest.json");
      let importRequests = 0;
      let actualImports = 0;
      let killedTargetId = "";
      let killedSignal: string | null = null;
      let workerReport: WorkerReport | undefined;
      const run = (interrupt: boolean): Promise<void> => new Promise((resolve, reject) => {
        let faultTriggered = false;
        let failure: unknown;
        const child: ChildProcess = fork(fileURLToPath(import.meta.url), [
          mode, server.directory, interrupt || mode === "large" ? "initial" : "resume",
        ], {
          execArgv: [`--max-old-space-size=${heapMiB}`, "--import", "tsx"],
          stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
        });
        let stderr = "";
        child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
        const timer = setTimeout(() => {
          failure = new Error(`Worker timeout: ${mode}`);
          child.kill("SIGKILL");
        }, 180_000);
        const handle = async (message: Request | WorkerReport) => {
          if (message.kind === "complete") { workerReport = message; return; }
          let value: unknown;
          if (message.method === "describe") value = await target.describe();
          else if (message.method === "read") value = await target.readSession(message.value as string);
          else {
            importRequests++;
            const transfer = message.value as Parameters<MigrationTarget["importSession"]>[0];
            const shouldKill = interrupt && importRequests === killAtImport;
            if (shouldKill) {
              const checkpoint = await readManifest(filename);
              assert.equal(checkpoint.sessions.filter((item) => item.state === "verified").length, killAtImport - 1);
              assert.equal(checkpoint.sessions.find((item) => item.targetId === transfer.info.id)?.state, "importing");
              await assert.rejects(withManifestStore(filename, async () => {}), { code: "T2O_MIGRATION_LOCKED" });
              killedTargetId = String(transfer.info.id);
            }
            if (!shouldKill || mode === "after-import") {
              value = await target.importSession(transfer);
              actualImports++;
            }
            if (shouldKill) {
              faultTriggered = true;
              assert.equal(child.kill("SIGKILL"), true);
              return; // No response/acknowledgement can reach the killed worker.
            }
          }
          if (child.connected) child.send({ kind: "reply", id: message.id, value });
        };
        child.on("message", (message: Request | WorkerReport) => {
          handle(message).catch((error) => { failure = error; child.kill("SIGKILL"); });
        });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          if (failure) { reject(failure); return; }
          if (faultTriggered) {
            killedSignal = signal;
            if (signal !== "SIGKILL") { reject(new Error(`Expected SIGKILL, got ${code}/${signal}`)); return; }
          } else if (code !== 0 || !workerReport) {
            reject(new Error(`Worker failed: ${mode}, ${code}/${signal}: ${stderr}`));
            return;
          }
          resolve();
        });
      });
      if (mode === "large") await run(false);
      else {
        await run(true);
        // OS lock is released by actual process death; no stale-lock deletion.
        await withManifestStore(filename, async (store) => { await store.read(); });
        const stored = await target.readSession(killedTargetId);
        assert.equal(stored !== null, mode === "after-import");
        await run(false);
      }
      assert.equal(actualImports, mode === "large" ? 1 : batchSize);
      assert.ok(workerReport);
      reports.push({
        ...workerReport, kind: undefined, heapLimitMiB: heapMiB,
        toolOutputBytes: mode === "large" ? 8 * 1024 * 1024 : undefined,
        actualImports, killedSignal, duplicateImports: 0,
      });
      console.log(JSON.stringify({ mode, status: "verified", actualImports }));
    }
    // A sparse oversized file must fail its byte gate before allocation/JSON parsing.
    const oversized = path.join(server.directory, "oversized.json");
    const file = await fs.open(oversized, "wx");
    try { await file.truncate(128 * 1024 * 1024 + 1); } finally { await file.close(); }
    await assert.rejects(readBundleFile(oversized), { code: "T2O_MIGRATION_BUNDLE_TOO_LARGE" });
    const report = {
      platform: process.platform, node: process.version, targetVersion: "2.0.12",
      source: "synthetic-pressure-fixtures", rssSamplingMs: 25,
      reports, oversizedFileRejected: true, status: "verified",
    };
    await fs.writeFile("tmp/m7-3-resilience-report.json", JSON.stringify(report, null, 2) + "\n");
  });
}

if (process.send) await worker();
else await parent();
