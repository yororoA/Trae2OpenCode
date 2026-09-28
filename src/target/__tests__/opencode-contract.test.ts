import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  analyzeOpenCodeSchema, assertOpenCodeSchema, assertOpenCodeTransfer,
  extractTransferSchema, TRANSFER_SCHEMA_HASH,
  openCodeDialectForVersion, isVerifiedOpenCodeVersion,
} from "../opencode/contract.js";
import {
  OPENCODE_PROTOCOL_RULES, protocolRuleForVersion,
} from "../opencode/protocol-rules.js";

const schema = JSON.parse(readFileSync(new URL(
  "../../../fixtures/opencode/2.0.12/evidence/transfer.schema.json", import.meta.url,
), "utf8"));
const transfer = JSON.parse(readFileSync(new URL(
  "../../../fixtures/opencode/2.0.12/session-transfer.json", import.meta.url,
), "utf8"));

describe("OpenCode transfer contract", () => {
  it("distinguishes stable adapter candidates from reviewed releases", () => {
    for (const version of ["2.0.11", "2.1.0", "2.99.999"]) {
      assert.equal(openCodeDialectForVersion(version), "v2");
      assert.equal(isVerifiedOpenCodeVersion(version), false);
    }
    for (const version of ["1.18.31", "1.19.0"]) {
      assert.equal(openCodeDialectForVersion(version), "v1");
      assert.equal(isVerifiedOpenCodeVersion(version), false);
    }
    for (const version of ["1.17.9", "1.18.32", "2.0.12", "2.0.16"]) {
      assert.equal(isVerifiedOpenCodeVersion(version), true);
    }
    for (const version of [null, "", "3.0.0", "2.1.0-beta", "v2.0.12", "2.00.12", "2.0.12\n"]) {
      assert.equal(openCodeDialectForVersion(version), undefined);
      assert.equal(isVerifiedOpenCodeVersion(version), false);
    }
  });

  it("selects version probes, operations and schema profiles from declarative rules", () => {
    assert.deepEqual(OPENCODE_PROTOCOL_RULES.map((rule) => ({
      id: rule.id,
      dialect: rule.dialect,
      versionRoute: rule.versionProbe.route,
      openapiRoute: rule.openapiRoute,
      operations: rule.operations.map(({ route, method }) => `${method.toUpperCase()} ${route}`),
      schemaProfile: rule.schemaProfile,
      transfer: rule.transfer,
    })), [
      {
        id: "v2-session-transfer", dialect: "v2",
        versionRoute: "/api/info", openapiRoute: "/openapi.json",
        operations: [
          "POST /api/experimental/session/import",
          "GET /api/experimental/session/{sessionID}/export",
        ],
        schemaProfile: "v2-transfer",
        transfer: "http",
      },
      {
        id: "v1-cli-library", dialect: "v1",
        versionRoute: "/global/health", openapiRoute: "/doc",
        operations: [
          "DELETE /session/{sessionID}",
          "GET /session/{sessionID}/children",
        ],
        schemaProfile: "v1-session",
        transfer: "cli",
      },
    ]);
    assert.equal(protocolRuleForVersion("2.0.18")?.id, "v2-session-transfer");
    assert.equal(protocolRuleForVersion("1.18.31")?.id, "v1-cli-library");
    assert.equal(protocolRuleForVersion("3.0.0"), undefined);
  });

  it("validates the reviewed fixture including all four tool states", () => {
    assert.doesNotThrow(() => assertOpenCodeTransfer(transfer));
    assert.equal(assertOpenCodeSchema(schema), TRANSFER_SCHEMA_HASH);
    assert.deepStrictEqual(extractTransferSchema(schema), schema);
  });

  it("rejects invalid message unions and preserves a safe error boundary", () => {
    const invalid = structuredClone(transfer);
    invalid.messages[0].type = "private-secret-value";
    assert.throws(() => assertOpenCodeTransfer(invalid), (error: unknown) => {
      assert.equal((error as { code: string }).code, "T2O_OPENCODE_TRANSFER_INVALID");
      assert.doesNotMatch(String(error), /private-secret/);
      return true;
    });
    const invalidTool = structuredClone(transfer);
    invalidTool.messages[1].content[2].state.content = [];
    assert.throws(() => assertOpenCodeTransfer(invalidTool), { code: "T2O_OPENCODE_TRANSFER_INVALID" });
  });

  it("admits additive optional fields as canary candidates but rejects breaking drift", () => {
    const changed = structuredClone(schema);
    changed.components.schemas["Session.Message.User"].properties.newField = { type: "string" };
    const analysis = analyzeOpenCodeSchema(changed);
    assert.equal(analysis.status, "compatible");
    assert.equal(assertOpenCodeSchema(changed), analysis.actualHash);
    assert.notEqual(analysis.actualHash, TRANSFER_SCHEMA_HASH);
    changed.components.schemas["Session.Message.User"].properties.text.type = "number";
    assert.equal(analyzeOpenCodeSchema(changed).status, "incompatible");
    assert.throws(() => assertOpenCodeSchema(changed), { code: "T2O_OPENCODE_SCHEMA_UNSUPPORTED" });
  });

  it("ignores unrelated API definitions and object-key order", () => {
    const changed = structuredClone(schema);
    changed.components.schemas.Unrelated = { type: "null" };
    changed.components.schemas["SessionTransfer.Data"] = Object.fromEntries(
      Object.entries(changed.components.schemas["SessionTransfer.Data"]).reverse(),
    );
    assert.equal(assertOpenCodeSchema(changed), TRANSFER_SCHEMA_HASH);
  });

  it("rejects missing, non-object and external schema references", () => {
    for (const invalid of [null, {}, { components: { schemas: {} } }]) {
      assert.throws(() => extractTransferSchema(invalid), { code: "T2O_OPENCODE_SCHEMA_UNSUPPORTED" });
    }
    const external = structuredClone(schema);
    external.components.schemas["SessionTransfer.Data"].properties.info.$ref = "https://example.invalid/schema";
    assert.throws(() => extractTransferSchema(external), { code: "T2O_OPENCODE_SCHEMA_UNSUPPORTED" });
    const missing = structuredClone(schema);
    delete missing.components.schemas["Session.Info"];
    assert.throws(() => extractTransferSchema(missing), { code: "T2O_OPENCODE_SCHEMA_UNSUPPORTED" });
    missing.components.schemas["Session.Info"] = false;
    assert.throws(() => extractTransferSchema(missing), { code: "T2O_OPENCODE_SCHEMA_UNSUPPORTED" });
  });

  it("terminates on recursive local schema graphs before refusing an unknown contract", () => {
    const recursive = { components: { schemas: {
      "SessionTransfer.Data": { $ref: "#/components/schemas/SessionTransfer.Data" },
    } } };
    const extracted = extractTransferSchema(recursive);
    assert.equal(Object.keys((extracted.components as typeof recursive.components).schemas).length, 1);
    assert.throws(() => assertOpenCodeSchema(recursive), { code: "T2O_OPENCODE_SCHEMA_UNSUPPORTED" });
  });
});
