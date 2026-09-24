import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonValue } from "../../ir/types.js";
import type { ErrorCode } from "../../shared/error-codes.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  assertOpenCodeSchema, EXPORT_ROUTE, IMPORT_ROUTE, isRecord,
  isSupportedOpenCodeVersion, TRANSFER_REF,
} from "./contract.js";
import type { OpenCodeTransport } from "./transport.js";

export interface OpenCodeCapabilities {
  binaryVersion: string | null;
  serverVersion: string | null;
  nativeImport: boolean;
  nativeExport: boolean;
  schemaHash: string | null;
  writable: boolean;
  reasons: ErrorCode[];
}

function parseVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^(?:opencode v?)?(\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-zA-Z0-9.-]{1,40})?)$/
    .exec(value.trim())?.[1] ?? null;
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

/** Read-only, fail-closed probe of both the executable and the actual target server. */
export async function probeOpenCodeCapabilities(transport: OpenCodeTransport): Promise<OpenCodeCapabilities> {
  const report: OpenCodeCapabilities = {
    binaryVersion: null, serverVersion: null, nativeImport: false, nativeExport: false,
    schemaHash: null, writable: false, reasons: [],
  };
  try {
    report.binaryVersion = parseVersion(await transport.run(["--version"]));
    if (!isSupportedOpenCodeVersion(report.binaryVersion)) {
      throw new Trae2OpenCodeError("T2O_OPENCODE_VERSION_UNSUPPORTED");
    }
    // OpenAPI's info.version is the HTTP surface version (0.0.1), not OpenCode's.
    const info = await transport.request("/api/info");
    report.serverVersion = info.status === 200 && isRecord(info.body) ? parseVersion(info.body.version) : null;
    if (!isSupportedOpenCodeVersion(report.serverVersion)) {
      throw new Trae2OpenCodeError("T2O_OPENCODE_VERSION_UNSUPPORTED");
    }
    const response = await transport.request("/openapi.json");
    const api = response.body;
    if (response.status !== 200 || !isRecord(api) || !isRecord(api.paths)) {
      throw new Trae2OpenCodeError("T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
    }
    const importPath = api.paths[IMPORT_ROUTE];
    const exportPath = api.paths[EXPORT_ROUTE];
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
    report.writable = true;
  } catch (error) {
    report.reasons.push(error instanceof Trae2OpenCodeError
      ? error.code : "T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
  }
  return report;
}

export async function requireOpenCodeCapabilities(transport: OpenCodeTransport): Promise<OpenCodeCapabilities> {
  const report = await probeOpenCodeCapabilities(transport);
  if (!report.writable) {
    throw new Trae2OpenCodeError(report.reasons[0] ?? "T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
  }
  return report;
}
