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
  T2O_TRAE_BUNDLE_INPUT_INVALID: {
    exitCode: 4,
    message: "TRAE bundle inputs have inconsistent versions, identities, or counts.",
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
  T2O_TRAE_RESOURCE_VERSION_UNSUPPORTED: {
    exitCode: 4,
    message: "The TRAE resource parser version is unsupported.",
  },
  T2O_TRAE_PROFILE_VERSION_UNSUPPORTED: {
    exitCode: 4,
    message: "The TRAE product version has no verified parser registration.",
  },
  T2O_TRAE_PROFILE_UNKNOWN: {
    exitCode: 4,
    message: "The TRAE parser profile is unknown.",
  },
  T2O_TRAE_PROFILE_REVISION_UNSUPPORTED: {
    exitCode: 4,
    message: "The TRAE parser profile revision is unsupported.",
  },
  T2O_TRAE_PROFILE_UNVERIFIED: {
    exitCode: 4,
    message: "The TRAE parser profile has not been verified.",
  },
  T2O_TRAE_PROFILE_CAPABILITY_UNSUPPORTED: {
    exitCode: 4,
    message: "The TRAE parser profile does not support this capability.",
  },
  T2O_OPENCODE_VERSION_UNSUPPORTED: {
    exitCode: 5,
    message: "The OpenCode version has no verified import contract.",
  },
  T2O_OPENCODE_SERVER_INVALID: {
    exitCode: 5,
    message: "OpenCode requires a local HTTP server URL without credentials or a path.",
  },
  T2O_OPENCODE_SERVER_START_FAILED: {
    exitCode: 5,
    message: "The isolated OpenCode server could not start.",
  },
  T2O_OPENCODE_COMMAND_FAILED: {
    exitCode: 5,
    message: "The OpenCode command failed or exceeded its time or output limit.",
  },
  T2O_OPENCODE_REQUEST_FAILED: {
    exitCode: 5,
    message: "The OpenCode request failed or exceeded its time or response limit.",
  },
  T2O_OPENCODE_CAPABILITY_UNAVAILABLE: {
    exitCode: 5,
    message: "OpenCode does not expose the required native import/export capabilities.",
  },
  T2O_OPENCODE_SCHEMA_UNSUPPORTED: {
    exitCode: 5,
    message: "The OpenCode transfer schema differs from the verified contract.",
  },
  T2O_OPENCODE_TRANSFER_INVALID: {
    exitCode: 5,
    message: "The transfer data does not satisfy the OpenCode schema.",
  },
  T2O_OPENCODE_MAPPING_REJECTED: {
    exitCode: 5,
    message: "The source session cannot be mapped to OpenCode without unverified or missing data.",
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
