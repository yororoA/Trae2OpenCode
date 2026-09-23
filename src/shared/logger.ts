import type { Diagnostic, JsonObject, JsonValue } from "../ir/types.js";
import { getDiagnosticLocation } from "./diagnostics.js";
import {
  normalizeError,
  type Trae2OpenCodeError,
} from "./errors.js";

export type LogLevel = "debug" | "info" | "warning" | "error";

export interface StructuredLogEvent {
  level: LogLevel;
  event: string;
  message: string;
  code?: string;
  context?: Record<string, unknown>;
}

export interface StructuredLogRecord {
  timestamp: string;
  level: LogLevel;
  event: string;
  message: string;
  code?: string;
  context?: JsonObject;
}

export type LogSink = (line: string) => void;
export type Clock = () => Date;

const SAFE_CONTEXT_KEYS = new Set([
  "command",
  "count",
  "diagnosticId",
  "diagnosticIds",
  "exitCode",
  "instancePath",
  "keyword",
  "operation",
  "productVersion",
  "profileId",
  "recovery",
  "schemaPath",
  "sourceKind",
  "status",
]);

const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s"'(])(?:\/Users\/|\/home\/|[A-Za-z]:[\\/])/;
const MAX_STRING_LENGTH = 256;
const MAX_ARRAY_ITEMS = 20;

function safeScalar(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }

  if (typeof value !== "string") {
    return "[REDACTED]";
  }

  if (ABSOLUTE_PATH_PATTERN.test(value)) {
    return "[REDACTED_PATH]";
  }

  if (value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]`;
  }

  return value;
}

export function sanitizeLogContext(
  context: Record<string, unknown>,
): JsonObject {
  return Object.fromEntries(
    Object.entries(context)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => {
        if (!SAFE_CONTEXT_KEYS.has(key)) {
          return [key, "[REDACTED]"];
        }

        if (Array.isArray(value)) {
          return [
            key,
            value.slice(0, MAX_ARRAY_ITEMS).map((item) => safeScalar(item)),
          ];
        }

        return [key, safeScalar(value)];
      }),
  );
}

export class JsonLogger {
  constructor(
    private readonly sink: LogSink,
    private readonly clock: Clock = () => new Date(),
  ) {}

  log(event: StructuredLogEvent): void {
    const context = event.context
      ? sanitizeLogContext(event.context)
      : undefined;
    const record: StructuredLogRecord = {
      timestamp: this.clock().toISOString(),
      level: event.level,
      event: event.event,
      message: event.message,
      ...(event.code ? { code: event.code } : {}),
      ...(context && Object.keys(context).length > 0 ? { context } : {}),
    };

    this.sink(`${JSON.stringify(record)}\n`);
  }

  error(
    event: string,
    error: unknown,
    context: Record<string, unknown> = {},
  ): Trae2OpenCodeError {
    const normalized = normalizeError(error);
    this.log({
      level: "error",
      event,
      code: normalized.code,
      message: normalized.message,
      context: {
        ...context,
        exitCode: normalized.exitCode,
        diagnosticIds: normalized.diagnostics.map(
          (diagnostic) => diagnostic.id,
        ),
      },
    });
    return normalized;
  }

  diagnostic(event: string, diagnostic: Diagnostic): void {
    this.log({
      level: diagnostic.severity,
      event,
      code: diagnostic.code,
      message: diagnostic.message,
      context: {
        diagnosticId: diagnostic.id,
        instancePath: getDiagnosticLocation(diagnostic),
        ...(diagnostic.context ?? {}),
      },
    });
  }
}
