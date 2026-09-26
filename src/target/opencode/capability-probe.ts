import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonValue } from "../../ir/types.js";
import type { ErrorCode } from "../../shared/error-codes.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  assertOpenCodeSchema, EXPORT_ROUTE, IMPORT_ROUTE, isRecord, isVerifiedOpenCodeVersion,
  openCodeDialectForVersion, parseOpenCodeVersion as parseVersion,
  supportedVersionsForDialect, TRANSFER_REF, type OpenCodeDialect,
} from "./contract.js";
import type { OpenCodeTransport } from "./transport.js";
import {
  assertOpenCodeV1Schema, V1_HEALTH_ROUTE, V1_OPENAPI_ROUTE, V1_SESSION_CHILDREN_ROUTE,
  V1_SESSION_ROUTE,
} from "./v1/contract.js";

export interface OpenCodeCapabilities {
  dialect: OpenCodeDialect;
  binaryVersion: string | null;
  serverVersion: string | null;
  nativeImport: boolean;
  nativeExport: boolean;
  schemaHash: string | null;
  writable: boolean;
  compatibility: "unsupported" | "protocol-only" | "verified-release" | "isolated-roundtrip";
  reasons: ErrorCode[];
}

export interface OpenCodeCompatibilityEvidence {
  dialect: OpenCodeDialect;
  binaryVersion: string;
  serverVersion: string;
  schemaHash: string;
}

function schemaAt(operation: unknown, response: boolean): unknown {
  if (!isRecord(operation)) return undefined;
  const responses = isRecord(operation.responses) ? operation.responses : {};
  const body = response ? responses["200"] : operation.requestBody;
  if (!isRecord(body) || !isRecord(body.content)) return undefined;
  const json = body.content["application/json"];
  return isRecord(json) ? json.schema : undefined;
}

const importBody: JsonValue = {
  type: "object",
  properties: {
    info: { $ref: "#/components/schemas/Session.Info" },
    messages: { type: "array", items: { $ref: "#/components/schemas/Session.Message.Info" } },
    location: { anyOf: [{ $ref: "#/components/schemas/Location.PublicRef" }, { type: "null" }] },
  },
  required: ["info", "messages"],
  additionalProperties: false,
};
const exportBody: JsonValue = {
  type: "object",
  properties: { data: { $ref: TRANSFER_REF } },
  required: ["data"],
  additionalProperties: false,
};

function matches(value: unknown, expected: JsonValue): boolean {
  return isRecord(value) && hashCanonicalJson(value as JsonValue) === hashCanonicalJson(expected);
}

function requireOpenApi(api: unknown, status: number, route: string): Record<string, unknown> {
  if (status !== 200 || !isRecord(api) || !isRecord(api.paths)) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
  }
  const paths = api.paths;
  if (!isRecord(paths[route])) throw new Trae2OpenCodeError("T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
  return paths;
}

/** v2 exposes the session transfer over HTTP and documents it at `/openapi.json`. */
async function probeV2(
  transport: OpenCodeTransport, report: OpenCodeCapabilities,
): Promise<void> {
  // OpenAPI's info.version is the HTTP surface version (0.0.1), not OpenCode's.
  const info = await transport.request("/api/info");
  report.serverVersion = info.status === 200 && isRecord(info.body) ? parseVersion(info.body.version) : null;
  if (openCodeDialectForVersion(report.serverVersion) !== "v2") {
    throw new Trae2OpenCodeError("T2O_OPENCODE_VERSION_UNSUPPORTED");
  }
  const response = await transport.request("/openapi.json");
  const api = response.body;
  const paths = requireOpenApi(api, response.status, IMPORT_ROUTE);
  const importPath = paths[IMPORT_ROUTE];
  const exportPath = paths[EXPORT_ROUTE];
  const importOperation = isRecord(importPath) ? importPath.post : undefined;
  const exportOperation = isRecord(exportPath) ? exportPath.get : undefined;
  report.nativeImport = isRecord(importOperation);
  report.nativeExport = isRecord(exportOperation);
  if (!report.nativeImport || !report.nativeExport) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
  }
  const validEnvelopes = matches(schemaAt(importOperation, false), importBody) &&
    matches(schemaAt(exportOperation, true), exportBody);
  if (!validEnvelopes) throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
  report.schemaHash = assertOpenCodeSchema(api);
}

/**
 * v1 has no session transfer route: `import` and `export` are top-level subcommands that
 * write the local session library directly. v1 prints its CLI usage to stderr, which the
 * transport deliberately never reads. Unreviewed releases therefore also require an
 * isolated CLI round trip; HTTP schema alone cannot establish import/export behavior.
 */
async function probeV1(
  transport: OpenCodeTransport, report: OpenCodeCapabilities,
): Promise<void> {
  const health = await transport.request(V1_HEALTH_ROUTE);
  report.serverVersion = health.status === 200 && isRecord(health.body)
    ? parseVersion(health.body.version) : null;
  if (openCodeDialectForVersion(report.serverVersion) !== "v1") {
    throw new Trae2OpenCodeError("T2O_OPENCODE_VERSION_UNSUPPORTED");
  }
  const response = await transport.request(V1_OPENAPI_ROUTE);
  const api = response.body;
  const paths = requireOpenApi(api, response.status, V1_SESSION_ROUTE);
  const supportsDelete = isRecord(paths[V1_SESSION_ROUTE]) && isRecord(paths[V1_SESSION_ROUTE].delete);
  const supportsChildren = isRecord(paths[V1_SESSION_CHILDREN_ROUTE]) &&
    isRecord(paths[V1_SESSION_CHILDREN_ROUTE].get);
  if (!supportsDelete || !supportsChildren) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
  }
  report.schemaHash = assertOpenCodeV1Schema(api);
  report.nativeImport = true;
  report.nativeExport = true;
}

/** Only reads version/HTTP evidence; never accesses user sessions. */
async function probeProtocol(transport: OpenCodeTransport): Promise<OpenCodeCapabilities> {
  const report: OpenCodeCapabilities = {
    dialect: "v2",
    binaryVersion: null, serverVersion: null, nativeImport: false, nativeExport: false,
    schemaHash: null, writable: false, compatibility: "unsupported", reasons: [],
  };
  try {
    report.binaryVersion = parseVersion(await transport.run(["--version"]));
    const dialect = openCodeDialectForVersion(report.binaryVersion);
    if (dialect === undefined) throw new Trae2OpenCodeError("T2O_OPENCODE_VERSION_UNSUPPORTED");
    report.dialect = dialect;
    if (dialect === "v1") await probeV1(transport, report);
    else await probeV2(transport, report);
    report.compatibility = "protocol-only";
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
  const reviewed = isVerifiedOpenCodeVersion(report.binaryVersion) &&
    isVerifiedOpenCodeVersion(report.serverVersion);
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
      dialect: report.dialect, binaryVersion: report.binaryVersion!,
      serverVersion: report.serverVersion!, schemaHash: report.schemaHash!,
    };
    await transport.verifyCompatibility(evidence);
    // A service restart/upgrade during the isolated run invalidates that evidence.
    const current = await probeProtocol(transport);
    const unchanged = current.reasons.length === 0 &&
      current.dialect === evidence.dialect &&
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
