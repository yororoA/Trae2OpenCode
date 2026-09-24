import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { JsonObject, MigrationBundle } from "../../ir/types.js";
import { EXPORT_ROUTE, IMPORT_ROUTE, TRANSFER_REF } from "../opencode/contract.js";
import { mapOpenCodeSession, type OpenCodeTransfer } from "../opencode/mapping.js";
import { createNativeOpenCodeAdapter } from "../opencode/native-adapter.js";
import type { OpenCodeTransport } from "../opencode/transport.js";

const bundle = JSON.parse(readFileSync(new URL(
  "../../../fixtures/ir/v1/valid-trae-assembled.json", import.meta.url,
), "utf8")) as MigrationBundle;
const schema = JSON.parse(readFileSync(new URL(
  "../../../fixtures/opencode/2.0.12/evidence/transfer.schema.json", import.meta.url,
), "utf8"));
const api = {
  components: schema.components,
  paths: {
    [IMPORT_ROUTE]: { post: { requestBody: { content: { "application/json": { schema: {
      type: "object", properties: {
        info: { $ref: "#/components/schemas/Session.Info" },
        messages: { type: "array", items: { $ref: "#/components/schemas/Session.Message.Info" } },
        location: { anyOf: [{ $ref: "#/components/schemas/Location.PublicRef" }, { type: "null" }] },
      }, required: ["info", "messages"], additionalProperties: false,
    } } } } } },
    [EXPORT_ROUTE]: { get: { responses: { "200": { content: { "application/json": { schema: {
      type: "object", properties: { data: { $ref: TRANSFER_REF } },
      required: ["data"], additionalProperties: false,
    } } } } } } },
  },
};

async function setup(run: (harness: {
  transfer: OpenCodeTransfer;
  adapter: ReturnType<typeof createNativeOpenCodeAdapter>;
  state: { stored: OpenCodeTransfer | null; version: string; fail: boolean; lose: boolean; wrongId: boolean; dropMessage: boolean };
  calls: string[][];
  root: string;
}) => Promise<void>) {
  await fs.mkdir("tmp", { recursive: true });
  const root = await fs.mkdtemp(path.resolve("tmp", "native test $() "));
  const transfer = mapOpenCodeSession(bundle, "session-synthetic", {
    sessionId: "ses_native", directory: root,
    messageIds: new Map([["user-synthetic", "msg_u"], ["assistant-synthetic", "msg_a"]]),
  }).transfer;
  const state = { stored: null as OpenCodeTransfer | null, version: "2.0.12", fail: false, lose: false, wrongId: false, dropMessage: false };
  const calls: string[][] = [];
  const transport: OpenCodeTransport = {
    async request(route) {
      if (route === "/api/info") return { status: 200, body: { version: state.version } };
      if (route === "/openapi.json") return { status: 200, body: api };
      assert.match(route, /^\/api\/experimental\/session\/ses_/);
      const matches = route === EXPORT_ROUTE.replace("{sessionID}", state.stored?.info.id ?? "");
      if (!matches || !state.stored) return { status: 404, body: null };
      const data = structuredClone(state.stored);
      if (state.wrongId) data.info.id = "ses_wrong";
      if (state.dropMessage) data.messages.pop();
      return { status: 200, body: { data } };
    },
    async run(args) {
      if (args[0] === "--version") return state.version;
      calls.push([...args]);
      if (args[1] === "export") return JSON.stringify(state.stored);
      assert.deepEqual(args.slice(3), ["--server", "http://127.0.0.1:9999", "--directory", root]);
      // Windows exposes synthetic mode bits; contents and cleanup remain checked.
      if (process.platform !== "win32") {
        assert.equal((await fs.stat(path.dirname(args[2]))).mode & 0o777, 0o700);
        assert.equal((await fs.stat(args[2])).mode & 0o777, 0o600);
      }
      const input = JSON.parse(await fs.readFile(args[2], "utf8")) as OpenCodeTransfer;
      if (state.fail) throw new Error("private command output");
      if (!state.lose) state.stored = input;
      return "ignored CLI success text";
    },
  };
  const adapter = createNativeOpenCodeAdapter({
    serverUrl: "http://127.0.0.1:9999", temporaryRoot: root, transport,
  });
  try { await run({ transfer, adapter, state, calls, root }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

describe("native OpenCode CLI adapter", () => {
  it("rejects credential-bearing transfers before invoking CLI or persisting temporary input", async () => {
    await setup(async ({ transfer, adapter, calls, root }) => {
      transfer.messages[0].text = "apiKey=synthetic-private-value";
      await assert.rejects(adapter.importSession(transfer), { code: "T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING" });
      assert.deepEqual(calls, []);
      assert.deepEqual(await fs.readdir(root), []);
    });
  });

  it("imports through literal CLI arguments, reads target data and cleans private temporary files", async () => {
    await setup(async ({ transfer, adapter, calls, root }) => {
      assert.deepEqual(await adapter.importSession(transfer), transfer);
      assert.equal(calls[0][1], "import");
      assert.deepEqual(await fs.readdir(root), []);
      assert.deepEqual(await adapter.exportSession(transfer.info.id), transfer);
      assert.deepEqual(await adapter.readSession(transfer.info.id), transfer);
    });
  });

  it("accepts the reviewed 2.0.16 transfer contract", async () => {
    await setup(async ({ transfer, adapter, state }) => {
      state.version = "2.0.16";
      assert.deepEqual(await adapter.importSession(transfer), transfer);
      assert.deepEqual(await adapter.readSession(transfer.info.id), transfer);
    });
  });

  it("refuses existing targets and missing parents without starting an import", async () => {
    await setup(async ({ transfer, adapter, state, calls }) => {
      state.stored = structuredClone(transfer);
      await assert.rejects(adapter.importSession(transfer), { code: "T2O_OPENCODE_SESSION_CONFLICT" });
      state.stored = null;
      transfer.info.parentID = "ses_parent";
      await assert.rejects(adapter.importSession(transfer), { code: "T2O_OPENCODE_PARENT_MISSING" });
      assert.equal(calls.length, 0);
    });
  });

  it("does not write when version, directory, completion or size gates fail", async () => {
    await setup(async ({ transfer, adapter, state, calls, root }) => {
      state.version = "2.0.13";
      await assert.rejects(adapter.importSession(transfer), { code: "T2O_OPENCODE_VERSION_UNSUPPORTED" });
      state.version = "2.0.12";
      transfer.info.location.directory = path.join(root, "missing");
      await assert.rejects(adapter.importSession(transfer), { code: "T2O_OPENCODE_DIRECTORY_INVALID" });
      transfer.info.location.directory = root;
      delete (transfer.messages[1].time as JsonObject).completed;
      await assert.rejects(adapter.importSession(transfer), { code: "T2O_OPENCODE_MAPPING_REJECTED" });
      (transfer.messages[1].time as JsonObject).completed = 1700000004000;
      transfer.messages[0].text = "x".repeat(32 * 1024 * 1024);
      await assert.rejects(adapter.importSession(transfer), { code: "T2O_OPENCODE_TRANSFER_TOO_LARGE" });
      assert.equal(calls.length, 0);
    });
  });

  it("cleans temporary files and redacts untyped command failures", async () => {
    await setup(async ({ transfer, adapter, state, root }) => {
      state.fail = true;
      await assert.rejects(adapter.importSession(transfer), (error: unknown) => {
        assert.equal((error as { code: string }).code, "T2O_OPENCODE_IMPORT_FAILED");
        assert.doesNotMatch(String(error), /private command output/);
        return true;
      });
      assert.deepEqual(await fs.readdir(root), []);
    });
  });

  it("requires an actual target session after command success", async () => {
    await setup(async ({ transfer, adapter, state, root }) => {
      state.lose = true;
      await assert.rejects(adapter.importSession(transfer), { code: "T2O_OPENCODE_READBACK_INVALID" });
      assert.deepEqual(await fs.readdir(root), []);
    });
  });

  it("rejects a readback with a different identity", async () => {
    await setup(async ({ transfer, adapter, state }) => {
      state.wrongId = true;
      await assert.rejects(adapter.importSession(transfer), { code: "T2O_OPENCODE_READBACK_INVALID" });
    });
  });

  it("rejects a schema-valid partial readback and still cleans private input files", async () => {
    await setup(async ({ transfer, adapter, state, root }) => {
      state.dropMessage = true;
      await assert.rejects(adapter.importSession(transfer), { code: "T2O_OPENCODE_RECONCILIATION_FAILED" });
      assert.deepEqual(await fs.readdir(root), []);
    });
  });

  it("snapshots caller data before async work and rejects nonlocal server origins", async () => {
    await setup(async ({ transfer, adapter }) => {
      const before = structuredClone(transfer);
      const pending = adapter.importSession(transfer);
      transfer.messages[0].text = "mutated";
      assert.deepEqual(await pending, before);
    });
    assert.throws(() => createNativeOpenCodeAdapter({ serverUrl: "http://example.com" }),
      { code: "T2O_OPENCODE_SERVER_INVALID" });
  });
});
