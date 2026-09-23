import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { createDiagnostic } from "../shared/diagnostics.js";
import { Trae2OpenCodeError } from "../shared/errors.js";
import { migrationBundleSchema } from "./schema.js";
import type { Diagnostic, MigrationBundle } from "./types.js";

export interface IrValidationIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
}

export type IrValidationResult =
  | {
      valid: true;
      value: MigrationBundle;
    }
  | {
      valid: false;
      issues: IrValidationIssue[];
    };

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: false,
});

const validate = ajv.compile(
  migrationBundleSchema,
) as ValidateFunction<MigrationBundle>;

function normalizeIssues(
  errors: ErrorObject[] | null | undefined,
): IrValidationIssue[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "schema validation failed",
  }));
}

function createValidationDiagnostics(
  issues: IrValidationIssue[],
): Diagnostic[] {
  return issues.map((issue, index) =>
    createDiagnostic({
      id: `ir-schema-${String(index + 1).padStart(4, "0")}`,
      severity: "error",
      code: "T2O_IR_SCHEMA_INVALID",
      message: issue.message,
      subject: {
        type: "bundle",
      },
      context: {
        instancePath: issue.instancePath || "/",
        schemaPath: issue.schemaPath,
        keyword: issue.keyword,
      },
    })
  );
}

export function validateMigrationBundle(value: unknown): IrValidationResult {
  if (validate(value)) {
    return {
      valid: true,
      value,
    };
  }

  return {
    valid: false,
    issues: normalizeIssues(validate.errors),
  };
}

export function assertMigrationBundle(value: unknown): MigrationBundle {
  const result = validateMigrationBundle(value);
  if (result.valid) {
    return result.value;
  }

  throw new Trae2OpenCodeError("T2O_IR_SCHEMA_INVALID", {
    diagnostics: createValidationDiagnostics(result.issues),
  });
}
