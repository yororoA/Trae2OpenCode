import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { hashCanonicalJson } from "../../../ir/canonical.js";
import type { JsonValue } from "../../../ir/types.js";
import { Trae2OpenCodeError } from "../../../shared/errors.js";
import { isRecord } from "../contract.js";
import {
  V1_HEALTH_ROUTE, V1_OPENAPI_ROUTE, V1_SESSION_CHILDREN_ROUTE, V1_SESSION_ROUTE,
} from "../protocol-rules.js";
import {
  analyzeSchemaCompatibility, type SchemaCompatibilityAnalysis,
} from "../schema-compatibility.js";
import type { OpenCodeSchemaProfile } from "../protocol-rules.js";

/**
 * OpenCode v1 exposes its OpenAPI document at `/doc`, keeps no session import/export
 * HTTP routes, and reports its version at `/global/health`.
 */
export {
  V1_HEALTH_ROUTE, V1_OPENAPI_ROUTE, V1_SESSION_CHILDREN_ROUTE, V1_SESSION_ROUTE,
};

const SCHEMA_REF_PREFIX = "#/components/schemas/";
const V1_SESSION_ROOTS = ["Session", "Message", "Part"] as const;

/** The fixture is the reviewed v1 contract: an envelope over v1's own schemas. */
const baseline = JSON.parse(readFileSync(new URL(
  "../../../../fixtures/opencode/1.18.32/evidence/session.schema.json", import.meta.url,
), "utf8")) as Record<string, unknown>;
const legacyBaseline = JSON.parse(readFileSync(new URL(
  "../../../../fixtures/opencode/1.16.0/evidence/session.schema.json", import.meta.url,
), "utf8")) as Record<string, unknown>;
export const V1_SESSION_SCHEMA_HASH = hashCanonicalJson(baseline as JsonValue);
export const V1_LEGACY_SESSION_SCHEMA_HASH = hashCanonicalJson(legacyBaseline as JsonValue);
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(baseline);
const validateLegacy = new Ajv2020({ strict: false, validateFormats: false }).compile(legacyBaseline);

export function assertOpenCodeV1Session(value: unknown): void {
  if (!validate(value)) throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_INVALID");
}

export function assertOpenCodeV1SessionForProfile(
  value: unknown, profile: OpenCodeSchemaProfile,
): void {
  const valid = profile === "v1-session-legacy" ? validateLegacy(value) : validate(value);
  if (!valid) throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_INVALID");
}

/** Extract only local schemas reachable from the v1 session roots, including cycles. */
export function extractV1SessionSchema(openapi: unknown): Record<string, unknown> {
  const components = isRecord(openapi) ? openapi.components : undefined;
  const schemas = isRecord(components) ? components.schemas : undefined;
  if (!isRecord(schemas)) throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
  const found = new Map<string, unknown>();
  const pending: unknown[] = V1_SESSION_ROOTS.map((name) => ({ $ref: `${SCHEMA_REF_PREFIX}${name}` }));
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
      if (typeof item !== "string" || !item.startsWith(SCHEMA_REF_PREFIX)) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
      }
      const name = item.slice(SCHEMA_REF_PREFIX.length);
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
    type: "object",
    additionalProperties: false,
    required: ["info", "messages"],
    properties: {
      info: { $ref: `${SCHEMA_REF_PREFIX}Session` },
      messages: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["info", "parts"],
          properties: {
            info: { $ref: `${SCHEMA_REF_PREFIX}Message` },
            parts: { type: "array", items: { $ref: `${SCHEMA_REF_PREFIX}Part` } },
          },
        },
      },
    },
    components: { schemas: Object.fromEntries(found) },
  };
}

export function assertOpenCodeV1Schema(openapi: unknown): string {
  const analysis = analyzeOpenCodeV1Schema(openapi);
  if (analysis.status === "incompatible") {
    throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
  }
  return analysis.actualHash;
}

export function analyzeOpenCodeV1Schema(
  openapi: unknown, profile: OpenCodeSchemaProfile = "v1-session",
): SchemaCompatibilityAnalysis {
  const schema = extractV1SessionSchema(openapi);
  return analyzeSchemaCompatibility(
    (profile === "v1-session-legacy" ? legacyBaseline : baseline) as JsonValue,
    schema as JsonValue,
  );
}
