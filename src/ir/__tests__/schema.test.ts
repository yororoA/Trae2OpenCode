import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import { migrationBundleSchema } from "../schema.js";
import {
  assertMigrationBundle,
  validateMigrationBundle,
} from "../validation.js";

function readFixture(name: string): unknown {
  const fixturePath = path.join(
    process.cwd(),
    "fixtures",
    "ir",
    "v1",
    name,
  );
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

describe("MigrationBundle v1 schema", () => {
  it("accepts the complete versioned fixture", () => {
    const fixture = readFixture("valid-complete.json");
    const result = validateMigrationBundle(fixture);

    assert.equal(result.valid, true);
    assert.equal(assertMigrationBundle(fixture).schemaVersion, 1);
  });

  it("rejects unknown fields instead of silently dropping them", () => {
    const fixture = readFixture("invalid-unknown-field.json");
    const result = validateMigrationBundle(fixture);

    assert.equal(result.valid, false);
    if (result.valid) return;
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.instancePath === "" &&
          issue.keyword === "additionalProperties",
      ),
    );
  });

  it("requires source references on every message and content block", () => {
    const fixture = structuredClone(
      assertMigrationBundle(readFixture("valid-complete.json")),
    );
    const assistant = fixture.sessions[0].events[1];
    assert.equal(assistant.type, "assistant");
    if (assistant.type !== "assistant") return;

    assistant.content[0].sourceRefs = [];
    const result = validateMigrationBundle(fixture);

    assert.equal(result.valid, false);
    if (result.valid) return;
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.instancePath.endsWith("/content/0/sourceRefs") &&
          issue.keyword === "minItems",
      ),
    );
  });

  it("rejects unrecognized tool states", () => {
    const fixture = structuredClone(
      assertMigrationBundle(readFixture("valid-complete.json")),
    );
    const assistant = fixture.sessions[0].events[1];
    assert.equal(assistant.type, "assistant");
    if (assistant.type !== "assistant") return;

    const tool = assistant.content[1];
    assert.equal(tool.type, "tool");
    if (tool.type !== "tool") return;
    (tool as { status: string }).status = "succeeded";

    const result = validateMigrationBundle(fixture);
    assert.equal(result.valid, false);
  });

  it("throws a coded error with locatable diagnostics", () => {
    const fixture = readFixture("invalid-unknown-field.json");

    assert.throws(
      () => assertMigrationBundle(fixture),
      (error) => {
        assert.ok(error instanceof Trae2OpenCodeError);
        assert.equal(error.code, "T2O_IR_SCHEMA_INVALID");
        assert.equal(error.exitCode, 3);
        assert.ok(error.diagnostics.length > 0);
        assert.equal(
          error.diagnostics[0].context?.instancePath,
          "/",
        );
        assert.doesNotMatch(error.message, /unmappedSourcePayload/);
        return true;
      },
    );
  });

  it("keeps the checked-in JSON Schema synchronized", () => {
    const schemaPath = path.join(
      process.cwd(),
      "schemas",
      "migration-bundle.v1.schema.json",
    );
    const checkedInSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

    assert.deepStrictEqual(checkedInSchema, migrationBundleSchema);
  });
});
