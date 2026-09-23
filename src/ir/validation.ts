import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { migrationBundleSchema } from "./schema.js";
import type { MigrationBundle } from "./types.js";

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

  const summary = result.issues
    .map((issue) => `${issue.instancePath || "/"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid migration bundle: ${summary}`);
}
