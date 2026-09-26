import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  probeOpenCodeCapabilities, requireOpenCodeCapabilities, type OpenCodeCompatibilityEvidence,
} from "../opencode/capability-probe.js";
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
  verify?: (evidence: OpenCodeCompatibilityEvidence) => Promise<void>;
} = {}) {
  const calls: string[] = [];
  const transport: OpenCodeTransport = {
    verifyCompatibility: options.verify,
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
      schemaHash: TRANSFER_SCHEMA_HASH, writable: true, compatibility: "verified-release", reasons: [],
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

  it("refuses unknown majors, prereleases and malformed versions before network access", async () => {
    for (const binaryVersion of ["3.0.0", "2.0.12-dev", "secret output", "v2.0.12", "2.0.12\nextra"]) {
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

  it("requires a matching local binary for an unreviewed running server", async () => {
    const { calls, transport } = connection({ serverVersion: "2.0.13" });
    const report = await probeOpenCodeCapabilities(transport);
    assert.equal(report.writable, false);
    assert.deepStrictEqual(calls, ["version", "/api/info", "/openapi.json"]);
    await assert.rejects(requireOpenCodeCapabilities(transport),
      { code: "T2O_OPENCODE_COMPATIBILITY_BINARY_REQUIRED" });
  });

  it("admits unreviewed stable v2 only after isolated proof and a fresh target probe", async () => {
    for (const version of ["2.0.11", "2.0.13", "2.1.0"]) {
      const verified: OpenCodeCompatibilityEvidence[] = [];
      const { calls, transport } = connection({
        binaryVersion: version, serverVersion: version,
        verify: async (evidence) => { verified.push(evidence); },
      });
      const report = await requireOpenCodeCapabilities(transport);
      assert.equal(report.compatibility, "isolated-roundtrip");
      assert.equal(report.writable, true);
      assert.deepEqual(verified, [{
        dialect: "v2", binaryVersion: version, serverVersion: version, schemaHash: TRANSFER_SCHEMA_HASH,
      }]);
      assert.deepEqual(calls, [
        "version", "/api/info", "/openapi.json", "version", "/api/info", "/openapi.json",
      ]);
    }
  });

  it("never authorizes an unreviewed version from schema alone or a failed canary", async () => {
    const options = { binaryVersion: "2.0.13", serverVersion: "2.0.13" };
    for (const verify of [undefined, async () => { throw new Error("private canary output"); }]) {
      const report = await probeOpenCodeCapabilities(connection({ ...options, verify }).transport);
      assert.equal(report.writable, false);
      assert.equal(report.compatibility, "protocol-only");
      assert.deepEqual(report.reasons, ["T2O_OPENCODE_COMPATIBILITY_UNVERIFIED"]);
      assert.doesNotMatch(JSON.stringify(report), /private canary/);
    }
  });

  it("rejects a target upgrade or schema change while the canary is running", async () => {
    for (const change of ["version", "schema"]) {
      const options = { binaryVersion: "2.0.13", serverVersion: "2.0.13", api: makeApi() };
      const { transport } = connection({
        ...options,
        verify: async () => {
          if (change === "version") transport.run = async () => "2.0.14";
          else options.api.components.schemas["Session.Message.User"].properties.text.type = "number";
        },
      });
      const report = await probeOpenCodeCapabilities(transport);
      assert.equal(report.writable, false);
      assert.deepEqual(report.reasons, ["T2O_MIGRATION_TARGET_CHANGED"]);
    }
  });

  it("does not execute the canary for an incompatible protocol or a reviewed release", async () => {
    const api = makeApi();
    delete api.paths[IMPORT_ROUTE];
    const report = await probeOpenCodeCapabilities(connection({
      binaryVersion: "2.0.13", serverVersion: "2.0.13", api,
      verify: async () => assert.fail("Invalid protocol must not run a canary"),
    }).transport);
    assert.deepEqual(report.reasons, ["T2O_OPENCODE_CAPABILITY_UNAVAILABLE"]);
    assert.equal((await requireOpenCodeCapabilities(connection({
      verify: async () => assert.fail("Reviewed release does not need a canary"),
    }).transport)).compatibility, "verified-release");
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
