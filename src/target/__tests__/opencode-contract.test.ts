import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  assertOpenCodeSchema, assertOpenCodeTransfer, extractTransferSchema, TRANSFER_SCHEMA_HASH,
} from "../opencode/contract.js";

const schema = JSON.parse(readFileSync(new URL(
  "../../../fixtures/opencode/2.0.12/evidence/transfer.schema.json", import.meta.url,
), "utf8"));
const transfer = JSON.parse(readFileSync(new URL(
  "../../../fixtures/opencode/2.0.12/session-transfer.json", import.meta.url,
), "utf8"));

describe("OpenCode transfer contract", () => {
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

  it("rejects schema drift even if only optional fields change", () => {
    const changed = structuredClone(schema);
    changed.components.schemas["Session.Message.User"].properties.newField = { type: "string" };
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
