import type { JsonValue } from "../../ir/types.js";

export type OpenCodeDialect = "v2" | "v1";
export type OpenCodeProtocolRuleId =
  "v2-session-transfer" | "v2-session-transfer-legacy" |
  "v1-cli-library" | "v1-cli-library-legacy";
export type OpenCodeSchemaProfile =
  "v2-transfer" | "v2-transfer-legacy" | "v1-session" | "v1-session-legacy";
export type OpenCodeMappingProfile = "v2-session-transfer" | "v1-session";
export type OpenCodeAdapterProfile =
  "v2-session-transfer" | "v2-session-transfer-legacy" | "v1-cli-library";
export type OpenCodeDeletionProfile = "v2-current" | "v2-legacy" | "v1";
export type OpenCodeCapabilityFlag = "nativeImport" | "nativeExport";

export interface OpenCodeOperationSchemaRule {
  source: "request" | "response";
  status?: string;
  expected: JsonValue;
}

export interface OpenCodeOperationRule {
  route: string;
  method: "get" | "post" | "delete";
  capability?: OpenCodeCapabilityFlag;
  schema?: OpenCodeOperationSchemaRule;
}

export interface OpenCodeProtocolRule {
  id: OpenCodeProtocolRuleId;
  dialect: OpenCodeDialect;
  versionPattern: string;
  reviewedVersions: readonly string[];
  versionProbe: { route: string; responseField: string };
  openapiRoute: string;
  operations: readonly OpenCodeOperationRule[];
  schemaProfile: OpenCodeSchemaProfile;
  mappingProfile: OpenCodeMappingProfile;
  adapterProfile: OpenCodeAdapterProfile;
  deletionProfile: OpenCodeDeletionProfile;
  transfer: "http" | "cli";
}

export const OPENCODE_CANDIDATE_VERSION_PATTERN =
  "^[12]\\.(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})$";
export const IMPORT_ROUTE = "/api/experimental/session/import";
export const EXPORT_ROUTE = "/api/experimental/session/{sessionID}/export";
export const LEGACY_IMPORT_ROUTE = "/api/session/import";
export const LEGACY_EXPORT_ROUTE = "/api/session/{sessionID}/export";
export const TRANSFER_REF = "#/components/schemas/SessionTransfer.Data";
export const V1_OPENAPI_ROUTE = "/doc";
export const V1_HEALTH_ROUTE = "/global/health";
export const V1_SESSION_ROUTE = "/session/{sessionID}";
export const V1_SESSION_CHILDREN_ROUTE = "/session/{sessionID}/children";

const importEnvelope: JsonValue = {
  type: "object",
  properties: {
    info: { $ref: "#/components/schemas/Session.Info" },
    messages: { type: "array", items: { $ref: "#/components/schemas/Session.Message.Info" } },
    location: { anyOf: [{ $ref: "#/components/schemas/Location.PublicRef" }, { type: "null" }] },
  },
  required: ["info", "messages"],
  additionalProperties: false,
};

const exportEnvelope: JsonValue = {
  type: "object",
  properties: { data: { $ref: TRANSFER_REF } },
  required: ["data"],
  additionalProperties: false,
};

const legacyImportEnvelope: JsonValue = {
  ...importEnvelope,
  properties: {
    ...(importEnvelope.properties as Record<string, JsonValue>),
    location: { anyOf: [{ $ref: "#/components/schemas/Location.Ref" }, { type: "null" }] },
  },
};

const v1Operations: readonly OpenCodeOperationRule[] = [
  { route: V1_SESSION_ROUTE, method: "delete" },
  { route: V1_SESSION_CHILDREN_ROUTE, method: "get" },
];

export const OPENCODE_PROTOCOL_RULES: readonly OpenCodeProtocolRule[] = [
  {
    id: "v2-session-transfer",
    dialect: "v2",
    versionPattern: "^2\\.(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})$",
    reviewedVersions: ["2.0.12", "2.0.16"],
    versionProbe: { route: "/api/info", responseField: "version" },
    openapiRoute: "/openapi.json",
    operations: [
      {
        route: IMPORT_ROUTE,
        method: "post",
        capability: "nativeImport",
        schema: { source: "request", expected: importEnvelope },
      },
      {
        route: EXPORT_ROUTE,
        method: "get",
        capability: "nativeExport",
        schema: { source: "response", status: "200", expected: exportEnvelope },
      },
    ],
    schemaProfile: "v2-transfer",
    mappingProfile: "v2-session-transfer",
    adapterProfile: "v2-session-transfer",
    deletionProfile: "v2-current",
    transfer: "http",
  },
  {
    id: "v2-session-transfer-legacy",
    dialect: "v2",
    versionPattern: "^2\\.(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})$",
    reviewedVersions: ["2.0.0"],
    versionProbe: { route: "/api/health", responseField: "version" },
    openapiRoute: "/openapi.json",
    operations: [
      {
        route: LEGACY_IMPORT_ROUTE,
        method: "post",
        capability: "nativeImport",
        schema: { source: "request", expected: legacyImportEnvelope },
      },
      {
        route: LEGACY_EXPORT_ROUTE,
        method: "get",
        capability: "nativeExport",
        schema: { source: "response", status: "200", expected: exportEnvelope },
      },
    ],
    schemaProfile: "v2-transfer-legacy",
    mappingProfile: "v2-session-transfer",
    adapterProfile: "v2-session-transfer-legacy",
    deletionProfile: "v2-legacy",
    transfer: "http",
  },
  {
    id: "v1-cli-library",
    dialect: "v1",
    versionPattern: "^1\\.(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})$",
    reviewedVersions: ["1.17.9", "1.18.32"],
    versionProbe: { route: V1_HEALTH_ROUTE, responseField: "version" },
    openapiRoute: V1_OPENAPI_ROUTE,
    operations: v1Operations,
    schemaProfile: "v1-session",
    mappingProfile: "v1-session",
    adapterProfile: "v1-cli-library",
    deletionProfile: "v1",
    transfer: "cli",
  },
  {
    id: "v1-cli-library-legacy",
    dialect: "v1",
    versionPattern: "^1\\.(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})$",
    reviewedVersions: ["1.16.0", "1.17.0"],
    versionProbe: { route: V1_HEALTH_ROUTE, responseField: "version" },
    openapiRoute: V1_OPENAPI_ROUTE,
    operations: v1Operations,
    schemaProfile: "v1-session-legacy",
    mappingProfile: "v1-session",
    adapterProfile: "v1-cli-library",
    deletionProfile: "v1",
    transfer: "cli",
  },
];

export function protocolRulesForVersion(value: string | null): readonly OpenCodeProtocolRule[] {
  if (value === null) return [];
  return OPENCODE_PROTOCOL_RULES.filter((rule) => new RegExp(rule.versionPattern).test(value));
}

export function protocolRuleForVersion(value: string | null): OpenCodeProtocolRule | undefined {
  return protocolRulesForVersion(value)[0];
}

export function protocolRuleById(id: OpenCodeProtocolRuleId): OpenCodeProtocolRule {
  const rule = OPENCODE_PROTOCOL_RULES.find((candidate) => candidate.id === id);
  if (!rule) throw new Error(`Unknown OpenCode protocol rule: ${id}`);
  return rule;
}

export function reviewedVersionsForDialect(dialect: OpenCodeDialect): readonly string[] {
  return OPENCODE_PROTOCOL_RULES
    .filter((candidate) => candidate.dialect === dialect)
    .flatMap((candidate) => candidate.reviewedVersions)
    .sort((left, right) => {
      const a = left.split(".").map(Number);
      const b = right.split(".").map(Number);
      return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
    });
}
