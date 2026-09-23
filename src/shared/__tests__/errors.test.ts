import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDiagnostic,
  getDiagnosticLocation,
} from "../diagnostics.js";
import { ERROR_DEFINITIONS } from "../error-codes.js";
import {
  normalizeError,
  Trae2OpenCodeError,
} from "../errors.js";
import { JsonLogger, sanitizeLogContext } from "../logger.js";

describe("Trae2OpenCodeError", () => {
  it("uses stable error definitions and exit codes", () => {
    const error = new Trae2OpenCodeError("T2O_IR_SCHEMA_INVALID");

    assert.equal(error.code, "T2O_IR_SCHEMA_INVALID");
    assert.equal(error.exitCode, 3);
    assert.equal(
      error.message,
      ERROR_DEFINITIONS.T2O_IR_SCHEMA_INVALID.message,
    );
  });

  it("normalizes unknown errors without exposing their messages", () => {
    const privateText = "private conversation and tool payload";
    const normalized = normalizeError(new Error(privateText));

    assert.equal(normalized.code, "T2O_INTERNAL_UNEXPECTED");
    assert.doesNotMatch(normalized.message, new RegExp(privateText));
    assert.equal(normalized.cause instanceof Error, true);
  });
});

describe("diagnostics", () => {
  it("creates locatable diagnostics with empty source refs by default", () => {
    const diagnostic = createDiagnostic({
      id: "ir-schema-0001",
      severity: "error",
      code: "T2O_IR_SCHEMA_INVALID",
      message: "must have required property",
      subject: {
        type: "bundle",
      },
      context: {
        instancePath: "/sessions/0/events/1",
      },
    });

    assert.deepStrictEqual(diagnostic.sourceRefs, []);
    assert.equal(
      getDiagnosticLocation(diagnostic),
      "/sessions/0/events/1",
    );
  });
});

describe("JsonLogger", () => {
  it("redacts context fields unless they are explicitly allowlisted", () => {
    const context = sanitizeLogContext({
      command: "scan",
      instancePath: "/sessions/0/events/1",
      text: "private conversation body",
      toolPayload: {
        output: "private tool output",
      },
      workingDirectory: "/Users/private/project",
    });

    assert.deepStrictEqual(context, {
      command: "scan",
      instancePath: "/sessions/0/events/1",
      text: "[REDACTED]",
      toolPayload: "[REDACTED]",
      workingDirectory: "[REDACTED]",
    });
  });

  it("writes deterministic JSON lines for safe application errors", () => {
    let output = "";
    const logger = new JsonLogger(
      (line) => {
        output += line;
      },
      () => new Date("2026-09-23T06:20:00.000Z"),
    );

    const error = logger.error(
      "migration.validate",
      new Error("private reasoning and output"),
      {
        operation: "validate",
        payload: "private payload",
      },
    );

    assert.equal(error.code, "T2O_INTERNAL_UNEXPECTED");
    assert.doesNotMatch(output, /private reasoning|private payload/);
    assert.deepStrictEqual(JSON.parse(output), {
      timestamp: "2026-09-23T06:20:00.000Z",
      level: "error",
      event: "migration.validate",
      message: "An unexpected internal error occurred.",
      code: "T2O_INTERNAL_UNEXPECTED",
      context: {
        diagnosticIds: [],
        exitCode: 1,
        operation: "validate",
        payload: "[REDACTED]",
      },
    });
  });
});
