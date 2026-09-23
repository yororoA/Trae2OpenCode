import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonValue } from "../../ir/types.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";

export const OPENCODE_VERSION = "2.0.12";
export const IMPORT_ROUTE = "/api/experimental/session/import";
export const EXPORT_ROUTE = "/api/experimental/session/{sessionID}/export";
export const TRANSFER_REF = "#/components/schemas/SessionTransfer.Data";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The fixture is also shipped in the npm package: it is the reviewed contract. */
const baseline = JSON.parse(readFileSync(new URL(
  "../../../fixtures/opencode/2.0.12/evidence/transfer.schema.json", import.meta.url,
), "utf8")) as Record<string, unknown>;
export const TRANSFER_SCHEMA_HASH = hashCanonicalJson(baseline as JsonValue);
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(baseline);

export function assertOpenCodeTransfer(value: unknown): void {
  if (!validate(value)) throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_INVALID");
}

/** Extract only local schemas reachable from the transfer root, including cycles. */
export function extractTransferSchema(openapi: unknown): Record<string, unknown> {
  const components = isRecord(openapi) ? openapi.components : undefined;
  const schemas = isRecord(components) ? components.schemas : undefined;
  if (!isRecord(schemas)) throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
  const found = new Map<string, unknown>();
  const pending: unknown[] = [{ $ref: TRANSFER_REF }];
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    if (++visited > 100_000) throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
    for (const [key, item] of Object.entries(value)) {
      if (key !== "$ref") {
        pending.push(item);
        continue;
      }
      const prefix = "#/components/schemas/";
      if (typeof item !== "string" || !item.startsWith(prefix)) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
      }
      const name = item.slice(prefix.length);
      if (found.has(name)) continue;
      if (!Object.hasOwn(schemas, name) || !isRecord(schemas[name])) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
      }
      found.set(name, schemas[name]);
      pending.push(schemas[name]);
    }
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: TRANSFER_REF,
    components: { schemas: Object.fromEntries(found) },
  };
}

export function assertOpenCodeSchema(openapi: unknown): string {
  const schema = extractTransferSchema(openapi);
  const actual = hashCanonicalJson(schema as JsonValue);
  if (actual !== TRANSFER_SCHEMA_HASH) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
  }
  return actual;
}
