import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonValue } from "../../ir/types.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  EXPORT_ROUTE, IMPORT_ROUTE, OPENCODE_CANDIDATE_VERSION_PATTERN,
  protocolRuleForVersion, protocolRulesForVersion, reviewedVersionsForDialect, TRANSFER_REF,
  type OpenCodeDialect, type OpenCodeSchemaProfile,
} from "./protocol-rules.js";
import {
  analyzeSchemaCompatibility, type SchemaCompatibilityAnalysis,
} from "./schema-compatibility.js";

export const OPENCODE_VERSION = "2.0.12";
/** OpenCode v2 (`@opencode/cli`): HTTP session transfer plus a service descriptor. */
export const OPENCODE_V2_VERSIONS = reviewedVersionsForDialect("v2");
/** OpenCode v1 (`opencode-ai`): CLI-only session transfer, no service descriptor. */
export const OPENCODE_V1_VERSIONS = reviewedVersionsForDialect("v1");
export const VERIFIED_OPENCODE_VERSIONS = [...OPENCODE_V2_VERSIONS, ...OPENCODE_V1_VERSIONS];
export {
  EXPORT_ROUTE, IMPORT_ROUTE, OPENCODE_CANDIDATE_VERSION_PATTERN, TRANSFER_REF,
  type OpenCodeDialect,
};

/**
 * Select a candidate adapter only. Protocol and (for unreviewed releases) isolated
 * behavioral verification must succeed before the candidate can read or write sessions.
 */
export function openCodeDialectForVersion(value: string | null): OpenCodeDialect | undefined {
  return protocolRuleForVersion(value)?.dialect;
}

export function supportedVersionsForDialect(dialect: OpenCodeDialect): readonly string[] {
  return reviewedVersionsForDialect(dialect);
}

export function isVerifiedOpenCodeVersion(value: string | null): boolean {
  return protocolRulesForVersion(value)
    .some((rule) => rule.reviewedVersions.includes(value ?? ""));
}

/** Every supported release reports the same `--version` / health version shape. */
export function parseOpenCodeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^(?:opencode v?)?(\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-zA-Z0-9.-]{1,40})?)$/
    .exec(value.trim())?.[1] ?? null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The fixture is also shipped in the npm package: it is the reviewed contract. */
const baseline = JSON.parse(readFileSync(new URL(
  "../../../fixtures/opencode/2.0.12/evidence/transfer.schema.json", import.meta.url,
), "utf8")) as Record<string, unknown>;
const legacyBaseline = JSON.parse(readFileSync(new URL(
  "../../../fixtures/opencode/2.0.0/evidence/transfer.schema.json", import.meta.url,
), "utf8")) as Record<string, unknown>;
export const TRANSFER_SCHEMA_HASH = hashCanonicalJson(baseline as JsonValue);
export const LEGACY_TRANSFER_SCHEMA_HASH = hashCanonicalJson(legacyBaseline as JsonValue);
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(baseline);
const validateLegacy = new Ajv2020({ strict: false, validateFormats: false }).compile(legacyBaseline);

export function assertOpenCodeTransfer(value: unknown): void {
  if (!validate(value)) throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_INVALID");
}

export function assertOpenCodeTransferForProfile(
  value: unknown,
  profile: Extract<OpenCodeSchemaProfile, "v2-transfer" | "v2-transfer-legacy">,
): void {
  const valid = profile === "v2-transfer-legacy" ? validateLegacy(value) : validate(value);
  if (!valid) throw new Trae2OpenCodeError("T2O_OPENCODE_TRANSFER_INVALID");
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
  const analysis = analyzeOpenCodeSchema(openapi);
  if (analysis.status === "incompatible") {
    throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
  }
  return analysis.actualHash;
}

export function analyzeOpenCodeSchema(
  openapi: unknown, profile: OpenCodeSchemaProfile = "v2-transfer",
): SchemaCompatibilityAnalysis {
  const schema = extractTransferSchema(openapi);
  return analyzeSchemaCompatibility(
    (profile === "v2-transfer-legacy" ? legacyBaseline : baseline) as JsonValue,
    schema as JsonValue,
  );
}
