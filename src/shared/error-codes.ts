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
  T2O_TRAE_WORKSPACE_STORAGE_UNREADABLE: {
    exitCode: 4,
    message: "TRAE workspace storage could not be read.",
  },
  T2O_TRAE_WORKSPACE_METADATA_NOT_FOUND: {
    exitCode: 4,
    message: "TRAE workspace metadata was not found.",
  },
  T2O_TRAE_WORKSPACE_METADATA_INVALID: {
    exitCode: 4,
    message: "TRAE workspace metadata is invalid.",
  },
  T2O_TRAE_WORKSPACE_URI_UNSUPPORTED: {
    exitCode: 4,
    message: "TRAE workspace URI is unsupported.",
  },
  T2O_TRAE_WORKSPACE_CONFIG_NOT_FOUND: {
    exitCode: 4,
    message: "TRAE workspace configuration was not found.",
  },
  T2O_TRAE_WORKSPACE_CONFIG_INVALID: {
    exitCode: 4,
    message: "TRAE workspace configuration is invalid.",
  },
  T2O_TRAE_SQLITE_SOURCE_NOT_FOUND: {
    exitCode: 4,
    message: "TRAE SQLite source was not found.",
  },
  T2O_TRAE_SQLITE_SOURCE_INVALID: {
    exitCode: 4,
    message: "TRAE SQLite source is invalid or unreadable.",
  },
  T2O_TRAE_SQLITE_SNAPSHOT_FAILED: {
    exitCode: 4,
    message: "TRAE SQLite snapshot could not be created.",
  },
  T2O_TRAE_SQLITE_SNAPSHOT_INVALID: {
    exitCode: 4,
    message: "TRAE SQLite snapshot failed integrity validation.",
  },
  T2O_TRAE_RUNTIME_PROBE_FAILED: {
    exitCode: 4,
    message: "TRAE runtime capability probe failed.",
  },
  T2O_TRAE_RECOVERY_EVIDENCE_INVALID: {
    exitCode: 4,
    message: "TRAE session recovery evidence is invalid.",
  },
  T2O_TRAE_SESSION_DISCOVERY_FAILED: {
    exitCode: 4,
    message: "TRAE session metadata discovery failed.",
  },
  T2O_TRAE_SESSION_EVIDENCE_PROVIDER_FAILED: {
    exitCode: 4,
    message: "TRAE session evidence provider failed.",
  },
  T2O_TRAE_SESSION_INDEX_VERSION_UNSUPPORTED: {
    exitCode: 4,
    message: "The TRAE session index version is unsupported.",
  },
  T2O_TRAE_SESSION_METADATA_PROVIDER_FAILED: {
    exitCode: 4,
    message: "The TRAE session metadata provider failed.",
  },
  T2O_TRAE_USER_MESSAGE_VERSION_UNSUPPORTED: {
    exitCode: 4,
    message: "The TRAE user message version is unsupported.",
  },
  T2O_TRAE_USER_MESSAGE_PROVIDER_FAILED: {
    exitCode: 4,
    message: "The TRAE user message provider failed.",
  },
  T2O_TRAE_ASSISTANT_MESSAGE_VERSION_UNSUPPORTED: {
    exitCode: 4,
    message: "The TRAE assistant message version is unsupported.",
  },
  T2O_TRAE_ASSISTANT_MESSAGE_PROVIDER_FAILED: {
    exitCode: 4,
    message: "The TRAE assistant message provider failed.",
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
