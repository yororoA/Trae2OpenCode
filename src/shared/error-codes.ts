export const ERROR_DEFINITIONS = {
  T2O_CLI_INVALID_ARGUMENTS: {
    exitCode: 2,
    message: "Invalid command-line arguments.",
  },
  T2O_CLI_UNKNOWN_COMMAND: {
    exitCode: 2,
    message: "Unknown command.",
  },
  T2O_CLI_COMMAND_NOT_IMPLEMENTED: {
    exitCode: 2,
    message: "This command is not implemented yet.",
  },
  T2O_IR_SCHEMA_INVALID: {
    exitCode: 3,
    message: "Migration bundle failed schema validation.",
  },
  T2O_TRAE_ROOT_NOT_FOUND: {
    exitCode: 4,
    message: "No readable TRAE data root was found.",
  },
  T2O_TRAE_PLATFORM_UNSUPPORTED: {
    exitCode: 4,
    message: "TRAE scanning is not supported on this platform.",
  },
  T2O_INTERNAL_UNEXPECTED: {
    exitCode: 1,
    message: "An unexpected internal error occurred.",
  },
} as const;

export type ErrorCode = keyof typeof ERROR_DEFINITIONS;

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_DEFINITIONS, value);
}
