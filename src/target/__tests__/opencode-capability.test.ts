import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { probeOpenCodeCapabilities, requireOpenCodeCapabilities } from "../opencode/capability-probe.js";
import { EXPORT_ROUTE, IMPORT_ROUTE, TRANSFER_REF, TRANSFER_SCHEMA_HASH } from "../opencode/contract.js";
import type { OpenCodeTransport } from "../opencode/transport.js";

function makeApi() {
  const schema = JSON.parse(readFileSync(new URL(
    "../../../fixtures/opencode/2.0.12/evidence/transfer.schema.json", import.meta.url,
  ), "utf8"));
  return {
    info: { version: "0.0.1" },
    components: schema.components,
    paths: {
      [IMPORT_ROUTE]: { post: {
        requestBody: { content: { "application/json": { schema: {
          type: "object",
          properties: {
            info: { $ref: "#/components/schemas/Session.Info" },
            messages: { type: "array", items: { $ref: "#/components/schemas/Session.Message.Info" } },
            location: { anyOf: [{ $ref: "#/components/schemas/Location.PublicRef" }, { type: "null" }] },
          },
          required: ["info", "messages"], additionalProperties: false,
        } } } },
      } },
      [EXPORT_ROUTE]: { get: {
        responses: { "200": { content: { "application/json": { schema: {
          type: "object", properties: { data: { $ref: TRANSFER_REF } },
          required: ["data"], additionalProperties: false,
        } } } } },
      } },
    } as Record<string, unknown>,
  };
}

function connection(options: {
  binaryVersion?: string; serverVersion?: string; status?: number; api?: unknown;
} = {}) {
  const calls: string[] = [];
  const transport: OpenCodeTransport = {
    async run(args) {
      assert.deepStrictEqual(args, ["--version"]);
      calls.push("version");
      return options.binaryVersion ?? "2.0.12\n";
    },
    async request(route) {
      calls.push(route);
      if (route === "/api/info") return {
        status: 200, body: { version: options.serverVersion ?? "2.0.12", paths: { private: "secret-path" } },
      };
      assert.equal(route, "/openapi.json");
      return { status: options.status ?? 200, body: options.api ?? makeApi() };
    },
  };
  return { calls, transport };
}

describe("probeOpenCodeCapabilities", () => {
  it("requires both product versions and the reviewed endpoint envelopes and schema", async () => {
    const { calls, transport } = connection();
    const report = await requireOpenCodeCapabilities(transport);
    assert.deepStrictEqual(report, {
      dialect: "v2", binaryVersion: "2.0.12", serverVersion: "2.0.12",
      nativeImport: true, nativeExport: true,
      schemaHash: TRANSFER_SCHEMA_HASH, writable: true, reasons: [],
    });
    assert.deepStrictEqual(calls, ["version", "/api/info", "/openapi.json"]);
    assert.doesNotMatch(JSON.stringify(report), /secret-path|0.0.1/);
  });

  it("accepts reviewed 2.0.12 and 2.0.16 client/server combinations", async () => {
    for (const binaryVersion of ["2.0.12", "2.0.16"]) {
      for (const serverVersion of ["2.0.12", "2.0.16"]) {
        const report = await requireOpenCodeCapabilities(
          connection({ binaryVersion, serverVersion }).transport,
        );
        assert.equal(report.binaryVersion, binaryVersion);
        assert.equal(report.serverVersion, serverVersion);
        assert.equal(report.schemaHash, TRANSFER_SCHEMA_HASH);
        assert.equal(report.writable, true);
      }
    }
  });

  it("refuses unknown, adjacent and malformed binary versions before network access", async () => {
    for (const binaryVersion of ["2.0.13", "2.0.11", "2.0.12-dev", "secret output", "v2.0.12", "2.0.12\nextra"]) {
      const { calls, transport } = connection({ binaryVersion });
      const report = await probeOpenCodeCapabilities(transport);
      assert.equal(report.writable, false);
      assert.deepStrictEqual(report.reasons, ["T2O_OPENCODE_VERSION_UNSUPPORTED"]);
      assert.deepStrictEqual(calls, ["version"]);
      assert.doesNotMatch(JSON.stringify(report), /secret output|extra/);
    }
    for (const binaryVersion of [
      "opencode 2.0.12", "opencode v2.0.12",
      "opencode 2.0.16", "opencode v2.0.16",
    ]) {
      assert.equal((await probeOpenCodeCapabilities(connection({ binaryVersion }).transport)).writable, true);
    }
  });

  it("does not trust the local binary version for a different running server", async () => {
    const { calls, transport } = connection({ serverVersion: "2.0.13" });
    const report = await probeOpenCodeCapabilities(transport);
    assert.equal(report.writable, false);
    assert.deepStrictEqual(calls, ["version", "/api/info"]);
    await assert.rejects(requireOpenCodeCapabilities(transport), { code: "T2O_OPENCODE_VERSION_UNSUPPORTED" });
  });

  it("reports missing import/export operations without enabling writes", async () => {
    for (const route of [IMPORT_ROUTE, EXPORT_ROUTE]) {
      const api = makeApi();
      delete api.paths[route];
      const report = await probeOpenCodeCapabilities(connection({ api }).transport);
      assert.equal(report.writable, false);
      assert.deepStrictEqual(report.reasons, ["T2O_OPENCODE_CAPABILITY_UNAVAILABLE"]);
    }
    for (const status of [401, 404, 500]) {
      const report = await probeOpenCodeCapabilities(connection({ status }).transport);
      assert.equal(report.writable, false);
      assert.equal(report.nativeImport, false);
    }
  });

  it("refuses endpoint shape changes even when transfer components still match", async () => {
    for (const route of [IMPORT_ROUTE, EXPORT_ROUTE]) {
      const api = makeApi();
      api.paths[route] = route === IMPORT_ROUTE ? { post: {} } : { get: {} };
      const report = await probeOpenCodeCapabilities(connection({ api }).transport);
      assert.equal(report.writable, false);
      assert.equal(report.nativeImport, true);
      assert.equal(report.nativeExport, true);
      assert.deepStrictEqual(report.reasons, ["T2O_OPENCODE_SCHEMA_UNSUPPORTED"]);
    }
  });

  it("refuses reachable schema drift but accepts unrelated API changes", async () => {
    const api = makeApi();
    api.components.schemas["Session.Message.User"].properties.text.type = "number";
    assert.deepStrictEqual((await probeOpenCodeCapabilities(connection({ api }).transport)).reasons,
      ["T2O_OPENCODE_SCHEMA_UNSUPPORTED"]);
    const unrelated = makeApi();
    unrelated.paths["/new-feature"] = { get: {} };
    unrelated.components.schemas.Unrelated = { type: "object" };
    assert.equal((await probeOpenCodeCapabilities(connection({ api: unrelated }).transport)).writable, true);
  });

  it("contains process and network errors without revealing their payloads", async () => {
    const { transport } = connection();
    transport.request = async () => { throw new Error("secret body /Users/private"); };
    const report = await probeOpenCodeCapabilities(transport);
    assert.equal(report.writable, false);
    assert.deepStrictEqual(report.reasons, ["T2O_OPENCODE_CAPABILITY_UNAVAILABLE"]);
    assert.doesNotMatch(JSON.stringify(report), /secret|private/);
  });
});
