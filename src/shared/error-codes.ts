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
  T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING: {
    exitCode: 4,
    message: "Credential-like content was detected. Remove credential values from the selected data and rebind credentials separately.",
  },
  T2O_SENSITIVE_SCAN_LIMIT: {
    exitCode: 4,
    message: "Data exceeds the sensitive-content inspection limit; select a smaller bundle.",
  },
  T2O_TRAE_BUNDLE_INPUT_INVALID: {
    exitCode: 4,
    message: "TRAE bundle inputs have inconsistent versions, identities, or counts.",
  },
  T2O_TRAE_VERSION_UNAVAILABLE: {
    exitCode: 4,
    message: "TRAE CN product version could not be read; provide --product-file.",
  },
  T2O_TRAE_RUNTIME_ENDPOINT_INVALID: {
    exitCode: 4,
    message: "TRAE runtime requires an explicit loopback HTTP debugging endpoint.",
  },
  T2O_TRAE_RUNTIME_UNAVAILABLE: {
    exitCode: 4,
    message: "TRAE runtime is unavailable or ambiguous; open TRAE with a debugging port and select --cdp-target if needed.",
  },
  T2O_TRAE_RUNTIME_READ_INVALID: {
    exitCode: 4,
    message: "TRAE runtime returned invalid, conflicting, or incomplete pages.",
  },
  T2O_TRAE_RUNTIME_LIMIT: {
    exitCode: 4,
    message: "TRAE data exceeds the supported 384 MiB per-session or 1 GiB total read limit; select fewer sessions.",
  },
  T2O_MIGRATION_SELECTION_EMPTY: {
    exitCode: 4,
    message: "No sessions match the requested selection.",
  },
  T2O_MIGRATION_BUNDLE_READ_FAILED: {
    exitCode: 4,
    message: "The migration bundle could not be read.",
  },
  T2O_MIGRATION_BUNDLE_NOT_FOUND: {
    exitCode: 4,
    message: "The migration bundle file was not found; check the --input path.",
  },
  T2O_MIGRATION_BUNDLE_TOO_LARGE: {
    exitCode: 4,
    message: "The migration bundle exceeds the supported 1 GiB size limit; export fewer sessions.",
  },
  T2O_MIGRATION_BUNDLE_INVALID_JSON: {
    exitCode: 3,
    message: "The migration bundle is not valid JSON.",
  },
  T2O_MIGRATION_EXPORT_FAILED: {
    exitCode: 4,
    message: "Export failed; choose a new output directory with an existing writable parent.",
  },
  T2O_MIGRATION_MANIFEST_INVALID: {
    exitCode: 4,
    message: "The migration manifest is invalid, incompatible, or unreadable.",
  },
  T2O_MIGRATION_CHECKPOINT_FAILED: {
    exitCode: 4,
    message: "The migration checkpoint could not be saved; target writes stopped.",
  },
  T2O_MIGRATION_LOCKED: {
    exitCode: 4,
    message: "Another process is using this migration manifest.",
  },
  T2O_MIGRATION_PLAN_CHANGED: {
    exitCode: 4,
    message: "The source bundle or migration options differ from the manifest.",
  },
  T2O_MIGRATION_TARGET_CHANGED: {
    exitCode: 5,
    message: "The target endpoint, contract, or previously created session has changed.",
  },
  T2O_MIGRATION_PARTIAL_WRITE: {
    exitCode: 5,
    message: "A session from this migration exists but failed reconciliation; no overwrite was attempted.",
  },
  T2O_MIGRATION_EXCLUSIVE_REQUIRED: {
    exitCode: 2,
    message: "Stop other target writers, then provide --exclusive-target to acknowledge exclusive use during deletion.",
  },
  T2O_MIGRATION_REPLACEMENT_INVALID: {
    exitCode: 5,
    message: "Replacement requires a verified tool-owned session and its unchanged readback hash in the previous manifest.",
  },
  T2O_MIGRATION_CHILDREN_PROTECTED: {
    exitCode: 5,
    message: "A child session is outside the deletion plan; no cascading deletion is allowed.",
  },
  T2O_MIGRATION_CONFIRMATION_REQUIRED: {
    exitCode: 2,
    message: "Review rollback preview and provide --confirm with its exact migration run ID.",
  },
  T2O_MIGRATION_ROLLBACK_STARTED: {
    exitCode: 5,
    message: "Rollback has started for this manifest; migration resume and replacement are disabled.",
  },
  T2O_MIGRATION_ROLLBACK_EVIDENCE_MISSING: {
    exitCode: 5,
    message: "Rollback requires the original readback hash or a fully reconciled interrupted import.",
  },
  T2O_OPENCODE_DELETE_FAILED: {
    exitCode: 5,
    message: "Session deletion did not complete; resume with the same manifest.",
  },
  T2O_OPENCODE_DELETE_UNSUPPORTED: {
    exitCode: 5,
    message: "The target lacks the verified session deletion and child-listing contract.",
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
  T2O_OPENCODE_IDENTITY_INVALID: {
    exitCode: 5,
    message: "Source identifiers or parent dependencies cannot form a unique OpenCode import plan.",
  },
  T2O_OPENCODE_READBACK_INVALID: {
    exitCode: 5,
    message: "OpenCode did not return the expected session transfer.",
  },
  T2O_OPENCODE_DIRECTORY_INVALID: {
    exitCode: 5,
    message: "The target project directory must be an existing absolute local directory.",
  },
  T2O_OPENCODE_PATH_MAP_INVALID: {
    exitCode: 5,
    message: "Project path mappings must use unambiguous absolute paths for each platform.",
  },
  T2O_OPENCODE_TRANSFER_TOO_LARGE: {
    exitCode: 5,
    message: "The OpenCode transfer exceeds the supported 384 MiB per-session or 1 GiB plan limit.",
  },
  T2O_OPENCODE_SESSION_CONFLICT: {
    exitCode: 5,
    message: "The target session already exists and was not overwritten.",
  },
  T2O_OPENCODE_PARENT_MISSING: {
    exitCode: 5,
    message: "The target parent session has not been imported.",
  },
  T2O_OPENCODE_IMPORT_FAILED: {
    exitCode: 5,
    message: "The native OpenCode import could not complete.",
  },
  T2O_OPENCODE_TEMP_CLEANUP_FAILED: {
    exitCode: 5,
    message: "The private import temporary directory could not be removed.",
  },
  T2O_OPENCODE_RECONCILIATION_FAILED: {
    exitCode: 5,
    message: "The imported OpenCode transcript does not match the planned transfer.",
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
