import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonValue } from "../../ir/types.js";
import {
  probeOpenCodeCapabilities, requireOpenCodeCapabilities, type OpenCodeCompatibilityEvidence,
} from "../opencode/capability-probe.js";
import {
  EXPORT_ROUTE, IMPORT_ROUTE, LEGACY_TRANSFER_SCHEMA_HASH, TRANSFER_REF,
  TRANSFER_SCHEMA_HASH,
} from "../opencode/contract.js";
import {
  LEGACY_EXPORT_ROUTE, LEGACY_IMPORT_ROUTE,
} from "../opencode/protocol-rules.js";
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

function makeLegacyApi() {
  const schema = JSON.parse(readFileSync(new URL(
    "../../../fixtures/opencode/2.0.0/evidence/transfer.schema.json", import.meta.url,
  ), "utf8"));
  return {
    info: { version: "0.0.1" },
    components: schema.components,
    paths: {
      [LEGACY_IMPORT_ROUTE]: { post: {
        requestBody: { content: { "application/json": { schema: {
          type: "object",
          properties: {
            info: { $ref: "#/components/schemas/Session.Info" },
            messages: { type: "array", items: { $ref: "#/components/schemas/Session.Message.Info" } },
            location: { anyOf: [{ $ref: "#/components/schemas/Location.Ref" }, { type: "null" }] },
          },
          required: ["info", "messages"], additionalProperties: false,
        } } } },
      } },
      [LEGACY_EXPORT_ROUTE]: { get: {
        responses: { "200": { content: { "application/json": { schema: {
          type: "object", properties: { data: { $ref: TRANSFER_REF } },
          required: ["data"], additionalProperties: false,
        } } } } },
      } },
    } as Record<string, unknown>,
  };
}

function importRequestSchema(api: ReturnType<typeof makeApi>) {
  const route = api.paths[IMPORT_ROUTE] as {
    post: {
      requestBody: {
        content: { "application/json": { schema: { properties: Record<string, unknown> } } };
      };
    };
  };
  return route.post.requestBody.content["application/json"].schema;
}

function connection(options: {
  binaryVersion?: string; serverVersion?: string; status?: number; api?: unknown;
  infoStatus?: number; healthStatus?: number;
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
        status: options.infoStatus ?? 200,
        body: { version: options.serverVersion ?? "2.0.12", paths: { private: "secret-path" } },
      };
      if (route === "/api/health") return {
        status: options.healthStatus ?? 200,
        body: { version: options.serverVersion ?? "2.0.0" },
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
    assert.match(report.protocolHash!, /^sha256:[a-f0-9]{64}$/);
    assert.deepStrictEqual(report, {
      dialect: "v2", protocolRule: "v2-session-transfer",
      protocolHash: report.protocolHash,
      binaryVersion: "2.0.12", serverVersion: "2.0.12",
      nativeImport: true, nativeExport: true,
      schemaHash: TRANSFER_SCHEMA_HASH, schemaCompatibility: "exact", schemaChanges: 0,
      writable: true, compatibility: "verified-release", reasons: [],
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

  it("selects and verifies the legacy v2 profile from its routes and schema", async () => {
    const { calls, transport } = connection({
      binaryVersion: "2.0.0", serverVersion: "2.0.0",
      infoStatus: 404, api: makeLegacyApi(),
    });
    const report = await requireOpenCodeCapabilities(transport);
    assert.equal(report.protocolRule, "v2-session-transfer-legacy");
    assert.equal(report.schemaHash, LEGACY_TRANSFER_SCHEMA_HASH);
    assert.equal(report.schemaCompatibility, "exact");
    assert.equal(report.compatibility, "verified-release");
    assert.equal(report.writable, true);
    assert.deepEqual(calls, [
      "version", "/api/info",
      "/api/health", "/openapi.json",
    ]);
  });

  it("requires isolated evidence for unreviewed releases using the legacy v2 profile", async () => {
    const verified: OpenCodeCompatibilityEvidence[] = [];
    const report = await requireOpenCodeCapabilities(connection({
      binaryVersion: "2.0.2", serverVersion: "2.0.2",
      infoStatus: 404, api: makeLegacyApi(),
      verify: async (evidence) => { verified.push(evidence); },
    }).transport);
    assert.equal(report.protocolRule, "v2-session-transfer-legacy");
    assert.equal(report.compatibility, "isolated-roundtrip");
    assert.equal(report.writable, true);
    assert.deepEqual(verified, [{
      dialect: "v2",
      protocolRule: "v2-session-transfer-legacy",
      protocolHash: report.protocolHash!,
      binaryVersion: "2.0.2",
      serverVersion: "2.0.2",
      schemaHash: LEGACY_TRANSFER_SCHEMA_HASH,
    }]);
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
        dialect: "v2", protocolRule: "v2-session-transfer",
        protocolHash: report.protocolHash!,
        binaryVersion: version, serverVersion: version, schemaHash: TRANSFER_SCHEMA_HASH,
      }]);
      assert.deepEqual(calls, [
        "version", "/api/info", "/openapi.json", "version", "/api/info", "/openapi.json",
      ]);
    }
  });

  it("requires an isolated round trip for additive schema changes, including reviewed versions", async () => {
    for (const version of ["2.0.12", "2.0.18"]) {
      const api = makeApi();
      api.components.schemas["Session.Message.User"].properties.optionalNewField = { type: "string" };
      const expectedHash = hashCanonicalJson({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $ref: TRANSFER_REF,
        components: api.components,
      } as JsonValue);
      const verified: OpenCodeCompatibilityEvidence[] = [];
      const report = await requireOpenCodeCapabilities(connection({
        binaryVersion: version, serverVersion: version, api,
        verify: async (evidence) => { verified.push(evidence); },
      }).transport);
      assert.equal(report.schemaCompatibility, "compatible");
      assert.equal(report.schemaChanges, 1);
      assert.equal(report.schemaHash, expectedHash);
      assert.equal(report.compatibility, "isolated-roundtrip");
      assert.deepEqual(verified, [{
        dialect: "v2", protocolRule: "v2-session-transfer",
        protocolHash: report.protocolHash!,
        binaryVersion: version, serverVersion: version, schemaHash: expectedHash,
      }]);
    }
  });

  it("never authorizes compatible schema drift without behavioral evidence", async () => {
    const api = makeApi();
    api.components.schemas["Session.Message.User"].properties.optionalNewField = { type: "string" };
    const report = await probeOpenCodeCapabilities(connection({ api }).transport);
    assert.equal(report.schemaCompatibility, "compatible");
    assert.equal(report.writable, false);
    assert.deepEqual(report.reasons, ["T2O_OPENCODE_COMPATIBILITY_UNVERIFIED"]);
  });

  it("analyzes endpoint envelopes and binds compatible changes to protocol evidence", async () => {
    const baseline = await requireOpenCodeCapabilities(connection().transport);
    const api = makeApi();
    importRequestSchema(api).properties.options = { type: "object" };
    const verified: OpenCodeCompatibilityEvidence[] = [];
    const report = await requireOpenCodeCapabilities(connection({
      binaryVersion: "2.0.18", serverVersion: "2.0.18", api,
      verify: async (evidence) => { verified.push(evidence); },
    }).transport);
    assert.equal(report.schemaCompatibility, "compatible");
    assert.equal(report.schemaChanges, 1);
    assert.equal(report.schemaHash, TRANSFER_SCHEMA_HASH);
    assert.notEqual(report.protocolHash, baseline.protocolHash);
    assert.equal(verified[0]?.protocolHash, report.protocolHash);
    assert.equal(report.compatibility, "isolated-roundtrip");
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
    for (const change of ["version", "schema", "envelope"]) {
      const options = { binaryVersion: "2.0.13", serverVersion: "2.0.13", api: makeApi() };
      const { transport } = connection({
        ...options,
        verify: async () => {
          if (change === "version") transport.run = async () => "2.0.14";
          else if (change === "schema") {
            options.api.components.schemas["Session.Message.User"].properties.text.type = "number";
          } else {
            importRequestSchema(options.api).properties.options = { type: "object" };
          }
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
