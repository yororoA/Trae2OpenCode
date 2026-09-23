import { createHash } from "node:crypto";
import type { JsonValue, MigrationBundle } from "./types.js";
import { assertMigrationBundle } from "./validation.js";

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }

  return value;
}

export function canonicalizeJson(value: JsonValue): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

export function hashCanonicalJson(value: JsonValue): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJson(value))
    .digest("hex")}`;
}

export function canonicalizeMigrationBundle(value: unknown): string {
  const bundle = assertMigrationBundle(value);
  return canonicalizeJson(bundle as unknown as JsonValue);
}

export function hashMigrationBundle(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizeMigrationBundle(value))
    .digest("hex")}`;
}

export function parseCanonicalMigrationBundle(
  serialized: string,
): MigrationBundle {
  return assertMigrationBundle(JSON.parse(serialized));
}
