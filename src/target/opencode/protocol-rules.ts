import type { JsonValue } from "../../ir/types.js";

export type OpenCodeDialect = "v2" | "v1";
export type OpenCodeProtocolRuleId = "v2-session-transfer" | "v1-cli-library";
export type OpenCodeSchemaProfile = "v2-transfer" | "v1-session";
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
  transfer: "http" | "cli";
}

export const OPENCODE_CANDIDATE_VERSION_PATTERN =
  "^[12]\\.(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})$";
export const IMPORT_ROUTE = "/api/experimental/session/import";
export const EXPORT_ROUTE = "/api/experimental/session/{sessionID}/export";
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
    transfer: "http",
  },
  {
    id: "v1-cli-library",
    dialect: "v1",
    versionPattern: "^1\\.(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})$",
    reviewedVersions: ["1.17.9", "1.18.32"],
    versionProbe: { route: V1_HEALTH_ROUTE, responseField: "version" },
    openapiRoute: V1_OPENAPI_ROUTE,
    operations: [
      { route: V1_SESSION_ROUTE, method: "delete" },
      { route: V1_SESSION_CHILDREN_ROUTE, method: "get" },
    ],
    schemaProfile: "v1-session",
    transfer: "cli",
  },
];

export function protocolRuleForVersion(value: string | null): OpenCodeProtocolRule | undefined {
  if (value === null) return undefined;
  return OPENCODE_PROTOCOL_RULES.find((rule) => new RegExp(rule.versionPattern).test(value));
}

export function protocolRuleById(id: OpenCodeProtocolRuleId): OpenCodeProtocolRule {
  const rule = OPENCODE_PROTOCOL_RULES.find((candidate) => candidate.id === id);
  if (!rule) throw new Error(`Unknown OpenCode protocol rule: ${id}`);
  return rule;
}

export function reviewedVersionsForDialect(dialect: OpenCodeDialect): readonly string[] {
  return OPENCODE_PROTOCOL_RULES
    .filter((candidate) => candidate.dialect === dialect)
    .flatMap((candidate) => candidate.reviewedVersions);
}
