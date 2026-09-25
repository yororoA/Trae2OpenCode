export const MEBIBYTE = 1024 * 1024;
export const GIBIBYTE = 1024 * MEBIBYTE;

/**
 * A bundle can contain several sessions and is parsed from a byte stream.
 * Individual transfers stay below V8's approximately 512 MiB string ceiling
 * because OpenCode's CLI still exchanges one session as a JSON string.
 */
export const MAX_BUNDLE_BYTES = GIBIBYTE;
export const MAX_RUNTIME_SESSION_BYTES = 384 * MEBIBYTE;
export const MAX_RUNTIME_TOTAL_BYTES = MAX_BUNDLE_BYTES;
export const MAX_OPENCODE_TRANSFER_BYTES = MAX_RUNTIME_SESSION_BYTES;
export const MAX_MIGRATION_PLAN_BYTES = MAX_BUNDLE_BYTES;
export const MAX_OPENCODE_RESPONSE_BYTES = MAX_OPENCODE_TRANSFER_BYTES + MEBIBYTE;
export const MAX_TRAE_CDP_MESSAGE_BYTES = MAX_RUNTIME_SESSION_BYTES + MEBIBYTE;
export const LARGE_TRANSFER_TIMEOUT_MS = 120_000;

export function formatByteLimit(bytes: number): string {
  return bytes % GIBIBYTE === 0
    ? `${bytes / GIBIBYTE} GiB`
    : `${bytes / MEBIBYTE} MiB`;
}
