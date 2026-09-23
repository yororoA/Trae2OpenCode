import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { collectTraeBundle, detectTraeVersion, selectBundle } from "../trae/collect.js";
import type { TraeRuntimeTransport } from "../trae/runtime-reader.js";

describe("TRAE bundle collection", () => {
  it("reads verified product metadata and rejects unrelated or absent product files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-version-"));
    const file = path.join(root, "product.json");
    try {
      await fs.writeFile(file, JSON.stringify({ applicationName: "trae-cn", appVersion: "3.3.104" }));
      assert.equal(await detectTraeVersion(file), "3.3.104");
      await fs.writeFile(file, JSON.stringify({ applicationName: "other", appVersion: "3.3.104" }));
      await assert.rejects(detectTraeVersion(file), { code: "T2O_TRAE_VERSION_UNAVAILABLE" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("combines runtime messages with workspace metadata and distinguishes unavailable reads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-collect-"));
    const workspace = path.join(root, "User/workspaceStorage/workspace-synthetic");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "workspace.json"), JSON.stringify({ folder: pathToFileURL(root).href }));
    const db = new Database(path.join(workspace, "state.vscdb"));
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("ai-chat-v2.lastActiveSessionId", "session-synthetic");
    db.close();
    const fixture = JSON.parse(await fs.readFile("fixtures/source/trae-cn-3.3.104/assembly.json", "utf8"));
    const options = {
      traeRoot: root, productVersion: "3.3.104", platform: process.platform === "win32" ? "win32" as const : "darwin" as const,
      collectedAt: "2026-09-24T00:00:00.000Z",
    };
    const transport: TraeRuntimeTransport = {
      productVersion: "3.3.104", close() {},
      async invoke(method) {
        return { code: 0, data: method === "getSession"
          ? { chat_session_id: "session-synthetic", title: "Synthetic", created_at: 1700000000000, updated_at: 1700000005000 }
          : { items: fixture.messageReads[0].value } };
      },
    };
    try {
      const offline = await collectTraeBundle(options);
      assert.equal(offline.sessions[0].recovery, "metadata-only");
      assert.deepEqual(offline.sessions[0].events, []);
      const live = await collectTraeBundle({ ...options, transport });
      assert.equal(live.sessions[0].recovery, "complete");
      assert.equal(live.sessions[0].events.length, 2);
      assert.equal(live.sessions[0].projectPath, root);
      assert.equal(selectBundle(live, { session: "session-synthetic", project: root }).sessions.length, 1);
      assert.throws(() => selectBundle(live, { session: "not-found" }), { code: "T2O_MIGRATION_SELECTION_EMPTY" });
      const failed = await collectTraeBundle({ ...options, transport: {
        ...transport, async invoke() { throw new Error("private response"); },
      } });
      assert.equal(failed.sessions[0].recovery, "metadata-only");
      assert.doesNotMatch(JSON.stringify(failed), /private response/);
      await assert.rejects(collectTraeBundle({ ...options, productVersion: "3.3.105" }),
        { code: "T2O_TRAE_PROFILE_VERSION_UNSUPPORTED" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
