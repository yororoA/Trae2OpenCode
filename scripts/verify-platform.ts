/** Real filesystem + SQLite + native OpenCode, synthetic TRAE runtime responses. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import type { MigrationBundle } from "../src/ir/types.js";
import { migrate, verifyMigration } from "../src/migration/executor.js";
import { buildMigrationPlan } from "../src/migration/plan.js";
import { createMigrationTarget } from "../src/migration/target.js";
import { collectTraeBundle } from "../src/source/trae/collect.js";
import { getDefaultTraeUserDataPaths, requireTraeRoot } from "../src/source/trae/path-discovery.js";
import { withIsolatedOpenCodeServer } from "../src/target/opencode/isolated-server.js";

await fs.mkdir("tmp", { recursive: true });
const root = await fs.mkdtemp(path.resolve("tmp", "platform 中文 "));
const platform = process.platform;
const env = { APPDATA: path.join(root, "Roaming"), LOCALAPPDATA: path.join(root, "Local") };
const discovery = { homeDir: root, env };
const sourceChecks: string[] = [];
let bundle: MigrationBundle;
try {
  if (platform === "darwin" || platform === "win32") {
    const defaults = getDefaultTraeUserDataPaths(discovery);
    assert.equal(defaults.length, platform === "darwin" ? 2 : 4);
    const messages = JSON.parse(await fs.readFile("fixtures/source/trae-cn-3.3.104/assembly.json", "utf8"));
    // Materialize each documented default independently, without overriding platform.
    for (const userDirectory of defaults) {
      const workspace = path.join(userDirectory, "workspaceStorage/workspace-synthetic");
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(path.join(workspace, "workspace.json"), JSON.stringify({ folder: pathToFileURL(root).href }));
      const filename = path.join(workspace, "state.vscdb");
      const database = new Database(filename);
      database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
      database.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("ai-chat-v2.lastActiveSessionId", "session-synthetic");
      database.close();
      const digest = async () => createHash("sha256").update(await fs.readFile(filename)).digest("hex");
      const before = await digest();
      const discovered = requireTraeRoot(discovery);
      assert.equal(discovered.source, "default");
      assert.equal(discovered.userDataPath, userDirectory);
      const options = { ...discovery, productVersion: "3.3.104", collectedAt: "2026-09-24T00:00:00.000Z" };
      const offline = await collectTraeBundle(options);
      assert.equal(offline.sessions.length, 1);
      assert.equal(offline.sessions[0].recovery, "metadata-only");
      const live = await collectTraeBundle({
        ...options,
        transport: {
          productVersion: "3.3.104", close() {},
          async invoke(method) {
            return { code: 0, data: method === "getSession" ? {
              chat_session_id: "session-synthetic", title: "Synthetic platform integration",
              created_at: 1700000000000, updated_at: 1700000005000,
            } : { items: messages.messageReads[0].value } };
          },
        },
      });
      assert.equal(live.sessions[0].recovery, "complete");
      assert.equal(live.sessions[0].events.length, 2);
      assert.equal(live.sessions[0].projectPath, root);
      assert.equal(await digest(), before);
      bundle = live;
      sourceChecks.push(path.relative(root, userDirectory).replaceAll("\\", "/"));
      await fs.rm(userDirectory, { recursive: true });
    }
  } else {
    assert.deepEqual(getDefaultTraeUserDataPaths(discovery), []);
    assert.throws(() => requireTraeRoot(discovery), { code: "T2O_TRAE_PLATFORM_UNSUPPORTED" });
    sourceChecks.push("source-platform-rejected");
    bundle = JSON.parse(await fs.readFile("fixtures/ir/v1/valid-trae-assembled.json", "utf8"));
  }
  const binary = process.env.T2O_TEST_OPENCODE_BINARY;
  await withIsolatedOpenCodeServer({
    temporaryRoot: root, ...(binary ? { binary: path.resolve(binary) } : {}),
  }, async (server) => {
    const plan = await buildMigrationPlan(bundle, { fallbackDirectory: server.directory });
    assert.equal(plan.sessions[0].status, "ready");
    const target = createMigrationTarget({ ...server, temporaryRoot: server.directory });
    const outputDirectory = path.join(server.directory, "manifest");
    const imported = await migrate(plan, target, { outputDirectory });
    assert.equal(imported.verified, 1);
    assert.equal(imported.created, 1);
    assert.equal(imported.hasFailures, false);
    const manifest = path.join(outputDirectory, "migration-manifest.json");
    const verified = await verifyMigration(manifest, target);
    assert.equal(verified.hasFailures, false);
    const repeated = await migrate(plan, target, { resumeManifest: manifest });
    assert.equal(repeated.hasFailures, false);
    const duplicate = await migrate(plan, target, { outputDirectory: path.join(server.directory, "duplicate") });
    assert.equal(duplicate.created, 0);
    assert.equal(duplicate.skipped, 1);
    const report = {
      platform, node: process.version, version: "2.0.12",
      source: "synthetic-runtime-fixture", sourceChecks,
      nativeImport: true, verified: verified.sessions.length, duplicateSkipped: duplicate.skipped,
      counts: verified.sessions[0].actual?.counts, status: "verified",
    };
    await fs.writeFile("tmp/m7-1-platform-report.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  });
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
