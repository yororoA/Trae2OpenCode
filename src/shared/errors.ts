import type { Diagnostic } from "../ir/types.js";
import {
  ERROR_DEFINITIONS,
  type ErrorCode,
} from "./error-codes.js";

interface Trae2OpenCodeErrorOptions {
  diagnostics?: Diagnostic[];
  cause?: unknown;
}

export class Trae2OpenCodeError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly diagnostics: readonly Diagnostic[];

  constructor(
    code: ErrorCode,
    options: Trae2OpenCodeErrorOptions = {},
  ) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message, { cause: options.cause });
    this.name = "Trae2OpenCodeError";
    this.code = code;
    this.exitCode = definition.exitCode;
    this.diagnostics = options.diagnostics ?? [];
  }
}

export function normalizeError(error: unknown): Trae2OpenCodeError {
  if (error instanceof Trae2OpenCodeError) {
    return error;
  }

  return new Trae2OpenCodeError("T2O_INTERNAL_UNEXPECTED", {
    cause: error,
  });
}
