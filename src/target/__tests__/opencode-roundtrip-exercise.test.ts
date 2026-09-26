import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonValue } from "../../ir/types.js";
import { exerciseOpenCodeRoundtrip } from "../opencode/compatibility.js";
import { IMPORT_ROUTE, TRANSFER_SCHEMA_HASH } from "../opencode/contract.js";
import type { IsolatedOpenCodeServer } from "../opencode/isolated-server.js";
import type { OpenCodeSession } from "../opencode/mapping.js";
import type { OpenCodeTransport } from "../opencode/transport.js";
import { V1_SESSION_SCHEMA_HASH } from "../opencode/v1/contract.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(
  `../../../fixtures/opencode/${name}`, import.meta.url,
), "utf8"));

async function setup(version: string, run: (harness: {
  server: IsolatedOpenCodeServer;
  state: { version: string; corrupt: boolean; upgradeAfterDelete: boolean };
  api: ReturnType<typeof fixture>;
  stored: Map<string, OpenCodeSession>;
  writes: string[];
}) => Promise<void>) {
  const v1 = version.startsWith("1.");
  const schema = fixture(v1 ? "1.18.32/evidence/session.schema.json" : "2.0.12/evidence/transfer.schema.json");
  const deletion = v1 ? { paths: {
    "/session/{sessionID}": { get: {}, delete: {} },
    "/session/{sessionID}/children": { get: {} },
  }, components: { schemas: {} } } : fixture("2.0.12/evidence/deletion.contract.json");
  const api = {
    paths: deletion.paths,
    components: { schemas: { ...schema.components.schemas, ...deletion.components.schemas } },
  };
  await fs.mkdir("tmp", { recursive: true });
  const directory = await fs.mkdtemp(path.resolve("tmp", "roundtrip-unit-"));
  const stored = new Map<string, OpenCodeSession>();
  const writes: string[] = [];
  const state = { version, corrupt: false, upgradeAfterDelete: false };
  const remove = (id: string) => {
    writes.push("delete");
    stored.delete(id);
    if (state.upgradeAfterDelete) state.version = v1 ? "1.17.9" : "2.0.16";
  };
  const transport: OpenCodeTransport = {
    async verifyCompatibility() { assert.fail("The exercise must not start a nested canary"); },
    async run(args) {
      if (args[0] === "--version") return state.version;
      const [command, value] = v1 ? args : args.slice(1);
      if (command === "export") return JSON.stringify(stored.get(value));
      if (command === "delete") { remove(value); return ""; }
      assert.equal(command, "import");
      writes.push("import");
      const input = JSON.parse(await fs.readFile(value, "utf8")) as OpenCodeSession;
      if (state.corrupt) input.messages.pop();
      stored.set(String(input.info.id), input);
      return "";
    },
    async request(route, options) {
      if (route === "/api/info" || route === "/global/health") {
        return { status: 200, body: { version: state.version } };
      }
      if (route === "/openapi.json" || route === "/doc") return { status: 200, body: api };
      const url = new URL(route, "http://127.0.0.1");
      const id = /\/(ses_[\w-]+)/.exec(route)?.[1];
      const isChildren = url.pathname === "/api/session" || url.pathname.endsWith("/children");
      if (isChildren) {
        const parent = v1 ? id : url.searchParams.get("parentID");
        const children = [...stored.values()].filter((item) => item.info.parentID === parent)
          .map((item) => item.info);
        return { status: 200, body: v1 ? children : { data: children, cursor: { next: null } } };
      }
      assert.ok(id, `Unexpected route: ${route}`);
      if (options?.method === "DELETE") {
        remove(id);
        return { status: 200, body: true };
      }
      const session = stored.get(id);
      return session
        ? { status: 200, body: structuredClone(v1 ? session.info : { data: session }) }
        : { status: 404, body: null };
    },
  };
  const server = {
    directory, serverUrl: "http://127.0.0.1:9999", transport, createTransport: () => transport,
  };
  try { await run({ server, state, api, stored, writes }); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

describe("shared isolated OpenCode roundtrip", () => {
  it("exercises baseline and unreviewed v1/v2 and reports the actual version and checks", async () => {
    for (const version of ["2.0.12", "2.0.18", "1.18.32", "1.18.31"]) {
      await setup(version, async ({ server, stored, writes }) => {
        const { report, schema } = await exerciseOpenCodeRoundtrip(server);
        const v1 = version.startsWith("1.");
        assert.equal(report.targetVersion, version);
        assert.equal(report.serverVersion, version);
        assert.equal(report.dialect, v1 ? "v1" : "v2");
        assert.equal(report.compatibility, ["2.0.12", "1.18.32"].includes(version)
          ? "verified-release" : "isolated-roundtrip");
        assert.equal(report.status, "verified");
        assert.equal(report.schemaSha256, v1 ? V1_SESSION_SCHEMA_HASH : TRANSFER_SCHEMA_HASH);
        assert.equal(hashCanonicalJson(schema as JsonValue), report.schemaSha256);
        assert.equal(report.checks.hiddenCompactionReadback, v1 ? undefined : true);
        assert.ok(Object.values(report.checks).every((value) => value === true));
        assert.equal(writes.filter((command) => command === "import").length, v1 ? 2 : 3);
        assert.equal(writes.filter((command) => command === "delete").length, v1 ? 2 : 3);
        assert.equal(stored.size, 0);
        assert.deepEqual(await fs.readdir(server.directory), []);
        assert.doesNotMatch(JSON.stringify(report), /127\.0\.0\.1|ses_compat|msg_compat|roundtrip-unit-/);
      });
    }
  });

  it("rejects protocol drift before importing even when the release is reviewed", async () => {
    for (const version of ["2.0.12", "2.0.18", "1.18.32", "1.18.31"]) {
      await setup(version, async ({ server, api, writes }) => {
        delete api.paths[version.startsWith("1.") ? "/session/{sessionID}" : IMPORT_ROUTE];
        await assert.rejects(exerciseOpenCodeRoundtrip(server),
          { code: "T2O_OPENCODE_CAPABILITY_UNAVAILABLE" });
        assert.deepEqual(writes, []);
      });
    }
  });

  it("binds the migration canary to the expected version and schema before writes", async () => {
    await setup("2.0.18", async ({ server, writes }) => {
      for (const evidence of [
        { binaryVersion: "2.0.11", serverVersion: "2.0.11", schemaHash: TRANSFER_SCHEMA_HASH },
        { binaryVersion: "2.0.18", serverVersion: "2.0.18", schemaHash: hashCanonicalJson("wrong") },
      ]) {
        await assert.rejects(exerciseOpenCodeRoundtrip(server, { dialect: "v2", ...evidence }),
          { code: "T2O_OPENCODE_COMPATIBILITY_UNVERIFIED" });
      }
      assert.deepEqual(writes, []);
    });
  });

  it("does not return a successful report when import silently drops a message", async () => {
    for (const version of ["2.0.18", "1.18.31"]) {
      await setup(version, async ({ server, state, writes }) => {
        state.corrupt = true;
        await assert.rejects(exerciseOpenCodeRoundtrip(server),
          { code: "T2O_OPENCODE_RECONCILIATION_FAILED" });
        assert.deepEqual(writes, ["import"]);
      });
    }
  });

  it("rejects a version change during the run, including a change to a reviewed release", async () => {
    for (const version of ["2.0.18", "1.18.31"]) {
      await setup(version, async ({ server, state }) => {
        state.upgradeAfterDelete = true;
        await assert.rejects(exerciseOpenCodeRoundtrip(server),
          { code: "T2O_OPENCODE_COMPATIBILITY_UNVERIFIED" });
      });
    }
  });
});
