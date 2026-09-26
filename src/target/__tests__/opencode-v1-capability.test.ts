import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { probeOpenCodeCapabilities, requireOpenCodeCapabilities } from "../opencode/capability-probe.js";
import { V1_HEALTH_ROUTE, V1_OPENAPI_ROUTE, V1_SESSION_SCHEMA_HASH } from "../opencode/v1/contract.js";
import type { OpenCodeTransport } from "../opencode/transport.js";

function makeV1Api() {
  const fixture = JSON.parse(readFileSync(new URL(
    "../../../fixtures/opencode/1.18.32/evidence/session.schema.json", import.meta.url,
  ), "utf8"));
  return {
    openapi: "3.1.0",
    info: { title: "opencode", version: "1.0.0" },
    components: fixture.components,
    paths: {
      "/session": { get: {}, post: {} },
      "/session/{sessionID}": { get: {}, delete: {}, patch: {} },
      "/session/{sessionID}/children": { get: {} },
    } as Record<string, unknown>,
  };
}

function connection(options: {
  binaryVersion?: string; serverVersion?: string; api?: unknown; healthStatus?: number;
  openapiStatus?: number; dropDelete?: boolean; dropChildren?: boolean;
} = {}) {
  const calls: string[] = [];
  const api = options.api ?? makeV1Api();
  const transport: OpenCodeTransport = {
    async run() {
      calls.push("version");
      return `${options.binaryVersion ?? "1.18.32"}\n`;
    },
    async request(route) {
      calls.push(route);
      if (route === V1_HEALTH_ROUTE) {
        return {
          status: options.healthStatus ?? 200,
          body: { healthy: true, version: options.serverVersion ?? "1.18.32" },
        };
      }
      assert.equal(route, V1_OPENAPI_ROUTE);
      const value = structuredClone(api) as { paths: Record<string, Record<string, unknown>> };
      if (options.dropDelete) delete value.paths["/session/{sessionID}"].delete;
      if (options.dropChildren) delete value.paths["/session/{sessionID}/children"].get;
      return { status: options.openapiStatus ?? 200, body: value };
    },
  };
  return { calls, transport };
}

describe("probeOpenCodeCapabilities for OpenCode v1", () => {
  it("accepts a verified v1 release and reports the v1 dialect and contract hash", async () => {
    const { calls, transport } = connection();
    const report = await requireOpenCodeCapabilities(transport);
    assert.deepStrictEqual(report, {
      dialect: "v1", binaryVersion: "1.18.32", serverVersion: "1.18.32",
      nativeImport: true, nativeExport: true,
      schemaHash: V1_SESSION_SCHEMA_HASH, writable: true, compatibility: "verified-release", reasons: [],
    });
    assert.deepStrictEqual(calls, ["version", V1_HEALTH_ROUTE, V1_OPENAPI_ROUTE]);
  });

  it("accepts the other verified v1 release", async () => {
    const { transport } = connection({ binaryVersion: "1.17.9", serverVersion: "1.17.9" });
    const report = await requireOpenCodeCapabilities(transport);
    assert.equal(report.dialect, "v1");
    assert.equal(report.binaryVersion, "1.17.9");
    assert.equal(report.writable, true);
  });

  it("fails closed on an unmatched v1 binary, a v2 server and a mismatched contract", async () => {
    await assert.rejects(
      requireOpenCodeCapabilities(connection({ binaryVersion: "1.18.31" }).transport),
      { code: "T2O_OPENCODE_COMPATIBILITY_BINARY_REQUIRED" },
    );
    await assert.rejects(
      requireOpenCodeCapabilities(connection({ serverVersion: "2.0.12" }).transport),
      { code: "T2O_OPENCODE_VERSION_UNSUPPORTED" },
    );
    await assert.rejects(
      requireOpenCodeCapabilities(connection({ healthStatus: 404 }).transport),
      { code: "T2O_OPENCODE_VERSION_UNSUPPORTED" },
    );
    const drifted = structuredClone(makeV1Api()) as { components: { schemas: Record<string, unknown> } };
    delete drifted.components.schemas.ReasoningPart;
    await assert.rejects(
      requireOpenCodeCapabilities(connection({ api: drifted }).transport),
      { code: "T2O_OPENCODE_SCHEMA_UNSUPPORTED" },
    );
  });

  it("requires isolated CLI evidence even when an unreviewed v1 HTTP schema matches", async () => {
    const { transport } = connection({ binaryVersion: "1.18.31", serverVersion: "1.18.31" });
    await assert.rejects(requireOpenCodeCapabilities(transport),
      { code: "T2O_OPENCODE_COMPATIBILITY_UNVERIFIED" });
    let canaries = 0;
    transport.verifyCompatibility = async (evidence) => {
      canaries++;
      assert.equal(evidence.dialect, "v1");
      assert.equal(evidence.binaryVersion, "1.18.31");
      assert.equal(evidence.schemaHash, V1_SESSION_SCHEMA_HASH);
    };
    const report = await requireOpenCodeCapabilities(transport);
    assert.equal(report.writable, true);
    assert.equal(report.compatibility, "isolated-roundtrip");
    assert.equal(canaries, 1);
    transport.verifyCompatibility = async () => { throw new Error("CLI cannot import"); };
    await assert.rejects(requireOpenCodeCapabilities(transport),
      { code: "T2O_OPENCODE_COMPATIBILITY_UNVERIFIED" });
  });

  it("fails closed when deletion or child listing is absent", async () => {
    await assert.rejects(
      requireOpenCodeCapabilities(connection({ dropDelete: true }).transport),
      { code: "T2O_OPENCODE_CAPABILITY_UNAVAILABLE" },
    );
    await assert.rejects(
      requireOpenCodeCapabilities(connection({ dropChildren: true }).transport),
      { code: "T2O_OPENCODE_CAPABILITY_UNAVAILABLE" },
    );
  });

  it("reports the reason without claiming writability", async () => {
    const report = await probeOpenCodeCapabilities(connection({ binaryVersion: "1.0.0" }).transport);
    assert.equal(report.writable, false);
    assert.equal(report.dialect, "v1");
    assert.deepStrictEqual(report.reasons, ["T2O_OPENCODE_COMPATIBILITY_BINARY_REQUIRED"]);
  });
});
