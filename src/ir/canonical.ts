import { createHash } from "node:crypto";
import { jsonChunks } from "../shared/json-stream.js";
import type { JsonValue, MigrationBundle } from "./types.js";
import { assertMigrationBundle } from "./validation.js";

const CANONICAL_OPTIONS = {
  pretty: true,
  sortKeys: true,
  trailingNewline: true,
} as const;

export function canonicalizeJson(value: JsonValue): string {
  return [...jsonChunks(value, CANONICAL_OPTIONS)].join("");
}

export function hashCanonicalJson(value: JsonValue): string {
  const hash = createHash("sha256");
  for (const chunk of jsonChunks(value, CANONICAL_OPTIONS)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

export function canonicalizeMigrationBundle(value: unknown): string {
  const bundle = assertMigrationBundle(value);
  return canonicalizeJson(bundle as unknown as JsonValue);
}

export function hashMigrationBundle(value: unknown): string {
  const bundle = assertMigrationBundle(value);
  return hashCanonicalJson(bundle as unknown as JsonValue);
}

export function parseCanonicalMigrationBundle(
  serialized: string,
): MigrationBundle {
  return assertMigrationBundle(JSON.parse(serialized));
}
