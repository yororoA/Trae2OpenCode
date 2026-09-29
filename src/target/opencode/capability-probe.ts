import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonValue } from "../../ir/types.js";
import type { ErrorCode } from "../../shared/error-codes.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  analyzeOpenCodeSchema, extractTransferSchema, isRecord, parseOpenCodeVersion as parseVersion,
  supportedVersionsForDialect, type OpenCodeDialect,
} from "./contract.js";
import {
  protocolRuleById, protocolRulesForVersion,
  type OpenCodeOperationRule, type OpenCodeProtocolRule,
  type OpenCodeProtocolRuleId,
} from "./protocol-rules.js";
import {
  analyzeSchemaCompatibility, type SchemaCompatibility,
  type SchemaCompatibilityAnalysis,
} from "./schema-compatibility.js";
import type { OpenCodeTransport } from "./transport.js";
import {
  analyzeOpenCodeV1Schema, extractV1SessionSchema,
} from "./v1/contract.js";

export interface OpenCodeCapabilities {
  dialect: OpenCodeDialect;
  protocolRule: OpenCodeProtocolRuleId | null;
  protocolHash: string | null;
  binaryVersion: string | null;
  serverVersion: string | null;
  nativeImport: boolean;
  nativeExport: boolean;
  schemaHash: string | null;
  schemaCompatibility: SchemaCompatibility | null;
  schemaChanges: number;
  writable: boolean;
  compatibility: "unsupported" | "protocol-only" | "verified-release" | "isolated-roundtrip";
  reasons: ErrorCode[];
}

export interface OpenCodeCompatibilityEvidence {
  dialect: OpenCodeDialect;
  protocolRule: OpenCodeProtocolRuleId;
  protocolHash: string;
  binaryVersion: string;
  serverVersion: string;
  schemaHash: string;
}

function schemaAt(operation: unknown, rule: OpenCodeOperationRule): unknown {
  if (!isRecord(operation)) return undefined;
  const responses = isRecord(operation.responses) ? operation.responses : {};
  const body = rule.schema?.source === "response"
    ? responses[rule.schema.status ?? "200"] : operation.requestBody;
  if (!isRecord(body) || !isRecord(body.content)) return undefined;
  const json = body.content["application/json"];
  return isRecord(json) ? json.schema : undefined;
}

function requireOpenApi(api: unknown, status: number): Record<string, unknown> {
  if (status !== 200 || !isRecord(api) || !isRecord(api.paths)) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
  }
  return api.paths;
}

function operationAt(
  paths: Record<string, unknown>, rule: OpenCodeOperationRule,
): unknown {
  const path = paths[rule.route];
  return isRecord(path) ? path[rule.method] : undefined;
}

export function extractSchemaForProtocolRule(
  rule: OpenCodeProtocolRule, openapi: unknown,
): Record<string, unknown> {
  return rule.schemaProfile === "v1-session" || rule.schemaProfile === "v1-session-legacy"
    ? extractV1SessionSchema(openapi) : extractTransferSchema(openapi);
}

function analyzeSchemaForProtocolRule(
  rule: OpenCodeProtocolRule, openapi: unknown,
): SchemaCompatibilityAnalysis {
  return rule.schemaProfile === "v1-session"
    ? analyzeOpenCodeV1Schema(openapi)
    : rule.schemaProfile === "v1-session-legacy"
      ? analyzeOpenCodeV1Schema(openapi, rule.schemaProfile)
      : analyzeOpenCodeSchema(openapi, rule.schemaProfile);
}

function combineSchemaAnalysis(
  report: OpenCodeCapabilities, analysis: SchemaCompatibilityAnalysis,
): void {
  if (analysis.status === "incompatible") {
    throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
  }
  if (report.schemaCompatibility !== "compatible") {
    report.schemaCompatibility = analysis.status;
  }
  report.schemaChanges += analysis.changeCount;
}

async function probeRule(
  transport: OpenCodeTransport, report: OpenCodeCapabilities, rule: OpenCodeProtocolRule,
): Promise<void> {
  const versionResponse = await transport.request(rule.versionProbe.route);
  const versionValue = versionResponse.status === 200 && isRecord(versionResponse.body)
    ? versionResponse.body[rule.versionProbe.responseField] : undefined;
  report.serverVersion = parseVersion(versionValue);
  if (!protocolRulesForVersion(report.serverVersion).some((candidate) => candidate.id === rule.id)) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_VERSION_UNSUPPORTED");
  }
  const response = await transport.request(rule.openapiRoute);
  const paths = requireOpenApi(response.body, response.status);
  const operationEvidence: JsonValue[] = [];
  for (const operationRule of rule.operations) {
    const operation = operationAt(paths, operationRule);
    if (operationRule.capability) report[operationRule.capability] = isRecord(operation);
    if (!isRecord(operation)) {
      throw new Trae2OpenCodeError("T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
    }
  }
  for (const operationRule of rule.operations) {
    const operation = operationAt(paths, operationRule);
    if (!operationRule.schema) continue;
    const operationSchema = schemaAt(operation, operationRule);
    if (!isRecord(operationSchema)) {
      throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
    }
    combineSchemaAnalysis(report, analyzeSchemaCompatibility(
      operationRule.schema.expected,
      operationSchema as JsonValue,
    ));
    operationEvidence.push({
      route: operationRule.route,
      method: operationRule.method,
      schema: operationSchema as JsonValue,
    });
  }
  for (const operationRule of rule.operations) {
    if (operationRule.schema) continue;
    operationEvidence.push({
      route: operationRule.route,
      method: operationRule.method,
      present: true,
    });
  }
  if (rule.transfer === "cli") {
    report.nativeImport = true;
    report.nativeExport = true;
  }
  const schemaAnalysis = analyzeSchemaForProtocolRule(rule, response.body);
  combineSchemaAnalysis(report, schemaAnalysis);
  report.schemaHash = schemaAnalysis.actualHash;
  report.protocolHash = hashCanonicalJson({
    rule: rule.id,
    operations: operationEvidence,
    schema: extractSchemaForProtocolRule(rule, response.body) as JsonValue,
  });
}

/** Only reads version/HTTP evidence; never accesses user sessions. */
async function probeProtocol(transport: OpenCodeTransport): Promise<OpenCodeCapabilities> {
  const emptyReport = (): OpenCodeCapabilities => ({
    dialect: "v2", protocolRule: null, protocolHash: null,
    binaryVersion: null, serverVersion: null, nativeImport: false, nativeExport: false,
    schemaHash: null, schemaCompatibility: null, schemaChanges: 0,
    writable: false, compatibility: "unsupported", reasons: [],
  });
  const report = emptyReport();
  try {
    report.binaryVersion = parseVersion(await transport.run(["--version"]));
    const rules = protocolRulesForVersion(report.binaryVersion);
    if (rules.length === 0) throw new Trae2OpenCodeError("T2O_OPENCODE_VERSION_UNSUPPORTED");
    let firstFailure: OpenCodeCapabilities | undefined;
    for (const rule of rules) {
      const candidate = {
        ...emptyReport(),
        dialect: rule.dialect,
        protocolRule: rule.id,
        binaryVersion: report.binaryVersion,
      };
      try {
        await probeRule(transport, candidate, rule);
        candidate.compatibility = "protocol-only";
        return candidate;
      } catch (error) {
        candidate.reasons.push(error instanceof Trae2OpenCodeError
          ? error.code : "T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
        firstFailure ??= candidate;
      }
    }
    return firstFailure!;
  } catch (error) {
    report.reasons.push(error instanceof Trae2OpenCodeError
      ? error.code : "T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
  }
  return report;
}

/** Target probe is read-only. Unreviewed versions are exercised in a disposable database. */
export async function probeOpenCodeCapabilities(transport: OpenCodeTransport): Promise<OpenCodeCapabilities> {
  const report = await probeProtocol(transport);
  if (report.reasons.length) return report;
  const rule = protocolRuleById(report.protocolRule!);
  const reviewed = rule.reviewedVersions.includes(report.binaryVersion!) &&
    rule.reviewedVersions.includes(report.serverVersion!) &&
    report.schemaCompatibility === "exact";
  if (reviewed) {
    report.compatibility = "verified-release";
    report.writable = true;
    return report;
  }
  try {
    // A local CLI of another version cannot demonstrate the running server's behavior.
    if (report.binaryVersion !== report.serverVersion) {
      throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_BINARY_REQUIRED");
    }
    if (!transport.verifyCompatibility) {
      throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
    }
    const evidence: OpenCodeCompatibilityEvidence = {
      dialect: report.dialect, protocolRule: report.protocolRule!,
      protocolHash: report.protocolHash!,
      binaryVersion: report.binaryVersion!,
      serverVersion: report.serverVersion!, schemaHash: report.schemaHash!,
    };
    await transport.verifyCompatibility(evidence);
    // A service restart/upgrade during the isolated run invalidates that evidence.
    const current = await probeProtocol(transport);
    const unchanged = current.reasons.length === 0 &&
      current.dialect === evidence.dialect &&
      current.protocolRule === evidence.protocolRule &&
      current.protocolHash === evidence.protocolHash &&
      current.binaryVersion === evidence.binaryVersion &&
      current.serverVersion === evidence.serverVersion &&
      current.schemaHash === evidence.schemaHash;
    if (!unchanged) throw new Trae2OpenCodeError("T2O_MIGRATION_TARGET_CHANGED");
    report.compatibility = "isolated-roundtrip";
    report.writable = true;
  } catch (error) {
    report.reasons.push(error instanceof Trae2OpenCodeError
      ? error.code : "T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
  }
  return report;
}

export async function requireOpenCodeCapabilities(
  transport: OpenCodeTransport,
): Promise<OpenCodeCapabilities> {
  const report = await probeOpenCodeCapabilities(transport);
  if (!report.writable) {
    throw new Trae2OpenCodeError(report.reasons[0] ?? "T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
  }
  return report;
}

export function supportedVersionLabel(dialect: OpenCodeDialect): string {
  return supportedVersionsForDialect(dialect).join(" / ");
}
