import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonObject, MigrationBundle } from "../../ir/types.js";
import type { OpenCodeTransport } from "../opencode/transport.js";
import { createOpenCodeV1Adapter } from "../opencode/v1/adapter.js";
import { mapOpenCodeV1Session, type OpenCodeV1Session } from "../opencode/v1/mapping.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../../../fixtures/ir/v1/valid-trae-assembled.json", import.meta.url,
), "utf8")) as MigrationBundle;

/** A v1 stand-in: CLI subcommands for transfer, HTTP routes for identity, children and delete. */
function createV1Target(directory: string) {
  const sessions = new Map<string, OpenCodeV1Session>();
  const calls: string[] = [];
  const cwds: string[] = [];
  let importSemantics: "stored" | "silently-empty" | "noop" = "stored";
  const transport: OpenCodeTransport = {
    async run(args, options) {
      calls.push(args[0]!);
      if (args[0] === "export") {
        const session = sessions.get(args[1]!);
        if (!session) throw Object.assign(new Error("missing"), { code: "T2O_OPENCODE_COMMAND_FAILED" });
        return JSON.stringify(session);
      }
      assert.equal(args[0], "import");
      cwds.push(options?.cwd ?? "");
      const value = JSON.parse(readFileSync(args[1]!, "utf8")) as OpenCodeV1Session;
      if (importSemantics === "stored") sessions.set(value.info.id, value);
      if (importSemantics === "silently-empty") sessions.set(value.info.id, { ...value, messages: [] });
      return "Imported session\n";
    },
    async request(route, requestOptions) {
      calls.push(`${requestOptions?.method ?? "GET"} ${route}`);
      const match = /^\/session\/([^/]+)/.exec(route);
      assert.ok(match, `unexpected route ${route}`);
      const id = match[1]!;
      if (route.endsWith("/children")) {
        const children = [...sessions.values()]
          .filter((item) => item.info.parentID === id)
          .map((item) => ({ id: item.info.id, parentID: id }));
        return { status: 200, body: children };
      }
      if (requestOptions?.method === "DELETE") {
        if (!sessions.has(id)) throw Object.assign(new Error("missing"), { code: "T2O_OPENCODE_REQUEST_FAILED" });
        sessions.delete(id);
        return { status: 200, body: true };
      }
      const session = sessions.get(id);
      return session ? { status: 200, body: { id } } : { status: 404, body: null };
    },
  };
  return {
    sessions, calls, cwds, transport,
    setImportSemantics(value: typeof importSemantics) { importSemantics = value; },
    plan(directoryOverride = directory) {
      return mapOpenCodeV1Session(fixture, "session-synthetic", {
        sessionId: "ses_v1_adapter",
        messageIds: new Map([["user-synthetic", "msg_0001_user"], ["assistant-synthetic", "msg_0002_assistant"]]),
        directory: directoryOverride,
        targetVersion: "1.18.32",
      }).transfer;
    },
  };
}

describe("native OpenCode v1 adapter", () => {
  it("imports through the literal CLI argument with the planned directory as cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-v1-adapter-"));
    const project = path.join(root, "project");
    await fs.mkdir(project);
    try {
      const target = createV1Target(project);
      const adapter = createOpenCodeV1Adapter({ transport: target.transport, temporaryRoot: path.join(root, "tmp") });
      const transfer = target.plan();
      const actual = await adapter.importSession(transfer);
      assert.deepEqual(actual, transfer);
      assert.deepEqual(target.calls.filter((call) => call === "import" || call === "export"), ["import", "export"]);
      assert.deepEqual(target.cwds, [project]);
      // The private input file must not survive the import.
      assert.deepEqual(await fs.readdir(path.join(root, "tmp")), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("streams an import above the former 32 MiB limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-v1-adapter-"));
    const project = path.join(root, "project");
    await fs.mkdir(project);
    try {
      const target = createV1Target(project);
      const adapter = createOpenCodeV1Adapter({ transport: target.transport, temporaryRoot: path.join(root, "tmp") });
      const transfer = target.plan();
      const parts = transfer.messages[0].parts as JsonObject[];
      parts[0].text = "x".repeat(32 * 1024 * 1024);
      assert.deepEqual(await adapter.importSession(transfer), transfer);
      assert.deepEqual(await fs.readdir(path.join(root, "tmp")), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("refuses an existing session, a missing parent and an invalid directory before importing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-v1-adapter-"));
    const project = path.join(root, "project");
    await fs.mkdir(project);
    try {
      const target = createV1Target(project);
      const adapter = createOpenCodeV1Adapter({ transport: target.transport, temporaryRoot: path.join(root, "tmp") });

      const missingDirectory = target.plan(path.join(root, "absent"));
      await assert.rejects(adapter.importSession(missingDirectory), { code: "T2O_OPENCODE_DIRECTORY_INVALID" });

      const transfer = target.plan();
      const orphan = structuredClone(transfer);
      orphan.info.id = "ses_v1_orphan";
      orphan.info.parentID = "ses_v1_absent_parent";
      await assert.rejects(adapter.importSession(orphan), { code: "T2O_OPENCODE_PARENT_MISSING" });

      await adapter.importSession(transfer);
      await assert.rejects(adapter.importSession(transfer), { code: "T2O_OPENCODE_SESSION_CONFLICT" });
      assert.equal(target.calls.filter((call) => call === "import").length, 1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects a readback that loses the transcript and still cleans the input file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-v1-adapter-"));
    const project = path.join(root, "project");
    await fs.mkdir(project);
    try {
      const target = createV1Target(project);
      target.setImportSemantics("silently-empty");
      const adapter = createOpenCodeV1Adapter({ transport: target.transport, temporaryRoot: path.join(root, "tmp") });
      await assert.rejects(adapter.importSession(target.plan()), { code: "T2O_OPENCODE_RECONCILIATION_FAILED" });
      assert.deepEqual(await fs.readdir(path.join(root, "tmp")), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("treats an accepted-but-absent import as a failed readback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-v1-adapter-"));
    const project = path.join(root, "project");
    await fs.mkdir(project);
    try {
      const target = createV1Target(project);
      target.setImportSemantics("noop");
      const adapter = createOpenCodeV1Adapter({ transport: target.transport, temporaryRoot: path.join(root, "tmp") });
      await assert.rejects(adapter.importSession(target.plan()), { code: "T2O_OPENCODE_READBACK_INVALID" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("lists children and deletes only a leaf whose readback is unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-v1-adapter-"));
    const project = path.join(root, "project");
    await fs.mkdir(project);
    try {
      const target = createV1Target(project);
      const adapter = createOpenCodeV1Adapter({ transport: target.transport, temporaryRoot: path.join(root, "tmp") });
      const transfer = target.plan();
      const stored = await adapter.importSession(transfer);
      assert.deepEqual(await adapter.read(String(stored.info.id)), stored);
      assert.equal(await adapter.read("ses_absent"), null);

      const child = structuredClone(transfer);
      child.info.id = "ses_v1_child";
      child.info.parentID = String(transfer.info.id);
      child.messages = [];
      target.sessions.set("ses_v1_child", child);
      assert.deepEqual(await adapter.listChildren(String(transfer.info.id)), ["ses_v1_child"]);
      await assert.rejects(
        adapter.deleteSession(String(transfer.info.id), hashCanonicalJson(transfer as unknown as JsonObject), true),
        { code: "T2O_MIGRATION_CHILDREN_PROTECTED" },
      );

      target.sessions.delete("ses_v1_child");
      await assert.rejects(
        adapter.deleteSession(String(transfer.info.id), hashCanonicalJson("stale" as unknown as JsonObject), true),
        { code: "T2O_MIGRATION_TARGET_CHANGED" },
      );
      await assert.rejects(
        adapter.deleteSession(String(transfer.info.id), hashCanonicalJson(transfer as unknown as JsonObject), false),
        { code: "T2O_MIGRATION_EXCLUSIVE_REQUIRED" },
      );
      await adapter.deleteSession(
        String(transfer.info.id), hashCanonicalJson(transfer as unknown as JsonObject), true,
      );
      assert.equal(await adapter.read(String(transfer.info.id)), null);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
