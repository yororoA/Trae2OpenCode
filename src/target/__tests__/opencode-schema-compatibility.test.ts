import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonValue } from "../../ir/types.js";
import { analyzeSchemaCompatibility } from "../opencode/schema-compatibility.js";

const closedObject: JsonValue = {
  type: "object",
  properties: {
    id: { type: "string" },
    state: { type: "string", enum: ["ready", "done"] },
  },
  required: ["id", "state"],
  additionalProperties: false,
};

function mutableClosedObject() {
  return structuredClone(closedObject) as {
    type: string;
    properties: Record<string, { type: string; enum?: string[] }>;
    required: string[];
    additionalProperties: boolean;
    minProperties?: number;
  };
}

describe("OpenCode schema compatibility analysis", () => {
  it("distinguishes exact schemas from compatible additive changes", () => {
    assert.deepEqual(analyzeSchemaCompatibility(closedObject, structuredClone(closedObject)), {
      status: "exact",
      baselineHash: analyzeSchemaCompatibility(closedObject, closedObject).baselineHash,
      actualHash: analyzeSchemaCompatibility(closedObject, closedObject).actualHash,
      changeCount: 0,
      changes: [],
    });

    const addedOptional = mutableClosedObject();
    addedOptional.properties.note = { type: "string" };
    const propertyAnalysis = analyzeSchemaCompatibility(closedObject, addedOptional);
    assert.equal(propertyAnalysis.status, "compatible");
    assert.equal(propertyAnalysis.changeCount, 1);
    assert.deepEqual(propertyAnalysis.changes, ["$.properties.note"]);
    assert.notEqual(propertyAnalysis.actualHash, propertyAnalysis.baselineHash);

    const widenedEnum = mutableClosedObject();
    widenedEnum.properties.state!.enum!.push("paused");
    assert.equal(analyzeSchemaCompatibility(closedObject, widenedEnum).status, "compatible");
  });

  it("allows additive union branches and ignores annotation-only changes", () => {
    const baseline: JsonValue = {
      anyOf: [
        { type: "string", enum: ["text"] },
        { type: "number" },
      ],
      description: "baseline",
    };
    const actual: JsonValue = {
      description: "updated",
      anyOf: [
        { type: "boolean" },
        { type: "number" },
        { type: "string", enum: ["text", "markdown"] },
      ],
    };
    const analysis = analyzeSchemaCompatibility(baseline, actual);
    assert.equal(analysis.status, "compatible");
    assert.ok(analysis.changeCount >= 3);
  });

  it("does not widen oneOf because a new overlapping branch can invalidate old data", () => {
    const baseline: JsonValue = { oneOf: [{ type: "string" }] };
    const actual: JsonValue = { oneOf: [{ type: "string" }, {}] };
    assert.equal(analyzeSchemaCompatibility(baseline, actual).status, "incompatible");
    assert.equal(analyzeSchemaCompatibility(
      { oneOf: [{ type: "string", enum: ["a"] }, { type: "string", enum: ["b"] }] },
      { oneOf: [{ type: "string", enum: ["a", "b"] }, { type: "string", enum: ["b"] }] },
    ).status, "incompatible");
  });

  it("treats required and enum ordering as semantic rather than structural", () => {
    const reordered = mutableClosedObject();
    reordered.required.reverse();
    reordered.properties.state!.enum!.reverse();
    const analysis = analyzeSchemaCompatibility(closedObject, reordered);
    assert.equal(analysis.status, "compatible");
    assert.notEqual(analysis.actualHash, analysis.baselineHash);
  });

  it("rejects breaking field, type, constraint and requirement changes", () => {
    const changes = [
      () => {
        const value = mutableClosedObject();
        delete value.properties.id;
        return value;
      },
      () => {
        const value = mutableClosedObject();
        value.properties.id!.type = "number";
        return value;
      },
      () => {
        const value = mutableClosedObject();
        value.required.push("note");
        value.properties.note = { type: "string" };
        return value;
      },
      () => {
        const value = mutableClosedObject();
        value.properties.state!.enum!.pop();
        return value;
      },
      () => ({ ...mutableClosedObject(), minProperties: 1 }),
    ];
    for (const change of changes) {
      assert.equal(analyzeSchemaCompatibility(closedObject, change()).status, "incompatible");
    }
  });

  it("does not call a new property compatible when the baseline object was open", () => {
    const baseline: JsonValue = { type: "object" };
    const actual: JsonValue = {
      type: "object",
      properties: { constrained: { type: "string" } },
    };
    assert.equal(analyzeSchemaCompatibility(baseline, actual).status, "incompatible");
  });

  it("allows added schema definitions but requires every baseline definition", () => {
    const baseline: JsonValue = {
      components: { schemas: { Existing: closedObject } },
    };
    const added: JsonValue = {
      components: { schemas: {
        Existing: structuredClone(closedObject),
        Added: { type: "string" },
      } },
    };
    assert.equal(analyzeSchemaCompatibility(baseline, added).status, "compatible");
    const missing: JsonValue = { components: { schemas: {} } };
    assert.equal(analyzeSchemaCompatibility(baseline, missing).status, "incompatible");
  });
});
