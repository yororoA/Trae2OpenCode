import * as crypto from "node:crypto";

export const TRAE_STRUCTURED_RUNTIME_PRODUCT_VERSION = "3.3.104";

export interface RedactedValueEvidence {
  type: string;
  chars: number;
  sha256: string;
  nonEmpty: boolean;
}

export interface StructuredTextEvidence {
  count: number;
  nonEmpty: number;
  totalChars: number;
  sampleHashes: string[];
}

export interface StructuredMessageSample {
  messageHash: string;
  turnHash: string | null;
  replyHash: string | null;
  role: string;
  status: string;
  messageType: string;
  messageIndex: number;
  contentEvidence: RedactedValueEvidence;
  queryEvidence: RedactedValueEvidence;
}

export interface StructuredToolSample {
  toolCallHash: string;
  nameEvidence: RedactedValueEvidence;
  paramsEvidence: RedactedValueEvidence;
  resultStatus: string;
  resultDataEvidence: RedactedValueEvidence;
  resultErrorEvidence: RedactedValueEvidence;
  timingKeys: string[];
}

export interface TraeStructuredRuntimeEvidence {
  evidenceVersion: 1;
  sourceProduct: {
    name: "trae-cn";
    version: "3.3.104";
  };
  source: {
    kind: "renderer-trae-api";
    serviceMethod: "TraeApi.chat.getMessages";
    endpoint: "lite/get_messages";
    service: "chat";
    method: "getMessages";
    environment: "local";
  };
  capture: {
    probeStatus: "completed-with-transport-failure";
    debugTransport: "debug-server-blocked-by-csp";
    sourceArtifactSha256: string;
  };
  verification: {
    status: "verified";
    sessionHash: string;
    sessionSelectionSource: "v2-current-selection";
    loadedSessionCandidateCount: number;
    pageCount: number;
  };
  counts: {
    messages: number;
    invalidMessageItems: number;
    roles: Record<string, number>;
    statuses: Record<string, number>;
    messageTypes: Record<string, number>;
    planItems: number;
    toolCalls: number;
  };
  relationship: {
    samples: number;
    matches: number;
    verified: true;
  };
  timingCoverage: {
    createdAt: number;
    chatStartTime: number;
    chatEndTime: number;
  };
  schema: {
    messageKeys: string[];
    assistantEnvelopeKeys: string[];
    assistantMessageKeys: string[];
    planItemKeys: string[];
    toolCallKeys: string[];
    toolResultKeys: string[];
  };
  textEvidence: Record<string, StructuredTextEvidence>;
  messageSamples: StructuredMessageSample[];
  toolSamples: StructuredToolSample[];
  privacy: {
    rawIdentifiersIncluded: false;
    rawTextIncluded: false;
    rawPathsIncluded: false;
    rawToolPayloadsIncluded: false;
  };
  evidenceSha256: string;
}

type JsonRecord = Record<string, unknown>;

const SHA256_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/;
const REQUIRED_SCHEMA_KEYS = {
  messageKeys: [
    "chat_end_time",
    "chat_session_id",
    "chat_start_time",
    "content",
    "created_at",
    "message_id",
    "message_index",
    "message_type",
    "query",
    "reply_to_message_id",
    "role",
    "status",
    "turn_id",
  ],
  assistantEnvelopeKeys: ["messages", "task_id", "user_message_id"],
  assistantMessageKeys: ["id", "plan_item", "type"],
  planItemKeys: [
    "id",
    "reasoning_content",
    "thought",
    "timing",
    "tool_call_info",
  ],
  toolCallKeys: ["id", "name", "params", "result"],
  toolResultKeys: ["data", "error_message", "status"],
} as const;
const REQUIRED_TEXT_FIELDS = [
  "user.query",
  "user.content",
  "planItem.thought",
  "planItem.reasoning_content",
] as const;
const REQUIRED_TOOL_TIMING_KEYS = [
  "generated_at_ms",
  "tool_call_finished_at_ms",
  "tool_call_started_at_ms",
] as const;

function sha256(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function fail(label: string): never {
  throw new Error(`Invalid TRAE structured runtime evidence: ${label}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(label);
  }
  return value as JsonRecord;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(label);
  return value;
}

function literalString<T extends string>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) fail(label);
  return expected;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    fail(label);
  }
  return value;
}

function booleanLiteral<T extends boolean>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) fail(label);
  return expected;
}

function normalizedHash(value: unknown, label: string): string {
  const hash = stringValue(value, label);
  if (!SHA256_PATTERN.test(hash)) fail(label);
  return hash.startsWith("sha256:") ? hash : `sha256:${hash}`;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : normalizedHash(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    fail(label);
  }
  return [...new Set(value)].sort();
}

function countRecord(value: unknown, label: string): Record<string, number> {
  const source = record(value, label);
  return Object.fromEntries(
    Object.entries(source)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => [
        key,
        nonNegativeInteger(count, `${label}.${key}`),
      ]),
  );
}

function redactedValue(
  value: unknown,
  label: string,
): RedactedValueEvidence {
  const source = record(value, label);
  return {
    type: stringValue(source.type, `${label}.type`),
    chars: nonNegativeInteger(source.chars, `${label}.chars`),
    sha256: normalizedHash(source.sha256, `${label}.sha256`),
    nonEmpty:
      typeof source.nonEmpty === "boolean"
        ? source.nonEmpty
        : fail(`${label}.nonEmpty`),
  };
}

function textEvidence(
  value: unknown,
  label: string,
): StructuredTextEvidence {
  const source = record(value, label);
  const count = nonNegativeInteger(source.count, `${label}.count`);
  const nonEmpty = nonNegativeInteger(source.nonEmpty, `${label}.nonEmpty`);
  if (nonEmpty > count) fail(`${label}.nonEmpty`);

  if (!Array.isArray(source.sampleHashes)) fail(`${label}.sampleHashes`);
  return {
    count,
    nonEmpty,
    totalChars: nonNegativeInteger(source.totalChars, `${label}.totalChars`),
    sampleHashes: source.sampleHashes.map((hash, index) =>
      normalizedHash(hash, `${label}.sampleHashes[${index}]`)
    ),
  };
}

function schema(value: unknown): TraeStructuredRuntimeEvidence["schema"] {
  const source = record(value, "report.schema");
  const result = {
    messageKeys: stringArray(source.messageKeys, "schema.messageKeys"),
    assistantEnvelopeKeys: stringArray(
      source.assistantEnvelopeKeys,
      "schema.assistantEnvelopeKeys",
    ),
    assistantMessageKeys: stringArray(
      source.assistantMessageKeys,
      "schema.assistantMessageKeys",
    ),
    planItemKeys: stringArray(source.planItemKeys, "schema.planItemKeys"),
    toolCallKeys: stringArray(source.toolCallKeys, "schema.toolCallKeys"),
    toolResultKeys: stringArray(source.toolResultKeys, "schema.toolResultKeys"),
  };

  for (const [group, requiredKeys] of Object.entries(REQUIRED_SCHEMA_KEYS)) {
    const observedKeys = result[group as keyof typeof result];
    for (const requiredKey of requiredKeys) {
      if (!observedKeys.includes(requiredKey)) {
        fail(`schema.${group} missing ${requiredKey}`);
      }
    }
  }
  return result;
}

function messageSamples(value: unknown): StructuredMessageSample[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("report.messageSamples");
  }
  return value.map((item, index) => {
    const source = record(item, `messageSamples[${index}]`);
    return {
      messageHash: normalizedHash(
        source.messageHash,
        `messageSamples[${index}].messageHash`,
      ),
      turnHash: nullableHash(
        source.turnHash,
        `messageSamples[${index}].turnHash`,
      ),
      replyHash: nullableHash(
        source.replyHash,
        `messageSamples[${index}].replyHash`,
      ),
      role: stringValue(source.role, `messageSamples[${index}].role`),
      status: stringValue(source.status, `messageSamples[${index}].status`),
      messageType: stringValue(
        source.messageType,
        `messageSamples[${index}].messageType`,
      ),
      messageIndex: nonNegativeInteger(
        source.messageIndex,
        `messageSamples[${index}].messageIndex`,
      ),
      contentEvidence: redactedValue(
        source.content,
        `messageSamples[${index}].content`,
      ),
      queryEvidence: redactedValue(
        source.query,
        `messageSamples[${index}].query`,
      ),
    };
  });
}

function toolSamples(value: unknown): StructuredToolSample[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("report.contentCoverage.toolSamples");
  }
  return value.map((item, index) => {
    const source = record(item, `toolSamples[${index}]`);
    const timingKeys = stringArray(
      source.timingKeys,
      `toolSamples[${index}].timingKeys`,
    );
    for (const requiredKey of REQUIRED_TOOL_TIMING_KEYS) {
      if (!timingKeys.includes(requiredKey)) {
        fail(`toolSamples[${index}].timingKeys missing ${requiredKey}`);
      }
    }
    return {
      toolCallHash: normalizedHash(
        source.idHash,
        `toolSamples[${index}].idHash`,
      ),
      nameEvidence: redactedValue(
        source.name,
        `toolSamples[${index}].name`,
      ),
      paramsEvidence: redactedValue(
        source.params,
        `toolSamples[${index}].params`,
      ),
      resultStatus: stringValue(
        source.resultStatus,
        `toolSamples[${index}].resultStatus`,
      ),
      resultDataEvidence: redactedValue(
        source.resultData,
        `toolSamples[${index}].resultData`,
      ),
      resultErrorEvidence: redactedValue(
        source.resultError,
        `toolSamples[${index}].resultError`,
      ),
      timingKeys,
    };
  });
}

function assertStructuredCoverage(
  evidence: Omit<TraeStructuredRuntimeEvidence, "evidenceSha256">,
): void {
  const assistantCount = evidence.counts.roles.assistant ?? 0;
  const userCount = evidence.counts.roles.user ?? 0;
  const hasCompleteRoleCounts =
    userCount > 0 &&
    assistantCount > 0 &&
    userCount + assistantCount === evidence.counts.messages;
  if (!hasCompleteRoleCounts) fail("counts.roles");
  const statusCount = Object.values(evidence.counts.statuses).reduce(
    (sum, count) => sum + count,
    0,
  );
  const messageTypeCount = Object.values(evidence.counts.messageTypes).reduce(
    (sum, count) => sum + count,
    0,
  );
  const hasCompleteClassificationCounts =
    statusCount === evidence.counts.messages &&
    messageTypeCount === evidence.counts.messages;
  if (!hasCompleteClassificationCounts) fail("counts classifications");
  if (evidence.counts.invalidMessageItems !== 0) {
    fail("counts.invalidMessageItems");
  }
  const hasRuntimePages =
    evidence.verification.loadedSessionCandidateCount > 0 &&
    evidence.verification.pageCount > 0;
  if (!hasRuntimePages) fail("verification runtime pages");

  const hasVerifiedRelationships =
    evidence.relationship.verified &&
    evidence.relationship.samples > 0 &&
    evidence.relationship.samples === evidence.relationship.matches &&
    evidence.relationship.samples === assistantCount;
  if (!hasVerifiedRelationships) fail("relationship");

  const hasCompleteTimingCoverage =
    evidence.timingCoverage.createdAt === evidence.counts.messages &&
    evidence.timingCoverage.chatStartTime === assistantCount &&
    evidence.timingCoverage.chatEndTime === assistantCount;
  if (!hasCompleteTimingCoverage) fail("timingCoverage");

  if (
    evidence.counts.planItems === 0 ||
    evidence.counts.planItems !== evidence.counts.toolCalls
  ) {
    fail("counts.planItems/toolCalls");
  }

  for (const field of REQUIRED_TEXT_FIELDS) {
    const coverage = evidence.textEvidence[field];
    if (!coverage || coverage.count === 0 || coverage.nonEmpty === 0) {
      fail(`textEvidence.${field}`);
    }
  }
  const hasCompleteTextCounts =
    evidence.textEvidence["user.query"].count === userCount &&
    evidence.textEvidence["user.content"].count === userCount &&
    evidence.textEvidence["planItem.thought"].count ===
      evidence.counts.planItems &&
    evidence.textEvidence["planItem.reasoning_content"].count ===
      evidence.counts.planItems;
  if (!hasCompleteTextCounts) fail("textEvidence counts");

  const sampledUserHashes = new Set(
    evidence.messageSamples
      .filter((sample) => sample.role === "user")
      .map((sample) => sample.messageHash),
  );
  const hasLinkedAssistantSample = evidence.messageSamples.some(
    (sample) =>
      sample.role === "assistant" &&
      sample.turnHash !== null &&
      sample.replyHash !== null &&
      sampledUserHashes.has(sample.replyHash) &&
      sample.contentEvidence.nonEmpty,
  );
  if (!hasLinkedAssistantSample) fail("messageSamples assistant relation");
  const sampledMessageIndices = evidence.messageSamples.map(
    (sample) => sample.messageIndex,
  );
  const hasOrderedMessageSamples =
    evidence.messageSamples.length <= evidence.counts.messages &&
    sampledMessageIndices.every(
      (messageIndex, index) =>
        index === 0 || messageIndex > sampledMessageIndices[index - 1],
    );
  if (!hasOrderedMessageSamples) fail("messageSamples order");

  const hasCompleteToolSample = evidence.toolSamples.some(
    (sample) =>
      sample.nameEvidence.nonEmpty &&
      sample.paramsEvidence.nonEmpty &&
      sample.resultDataEvidence.nonEmpty &&
      sample.resultDataEvidence.type !== "undefined" &&
      sample.resultStatus.length > 0,
  );
  if (!hasCompleteToolSample) fail("toolSamples complete payload");
  if (evidence.toolSamples.length > evidence.counts.toolCalls) {
    fail("toolSamples count");
  }
}

function assertNoPrivateValues(value: unknown): void {
  const serialized = JSON.stringify(value);
  const forbiddenPatterns = [
    /\/Users\//,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    /"message_id"\s*:/,
    /"turn_id"\s*:/,
    /"reply_to_message_id"\s*:/,
    /"params"\s*:/,
    /"result"\s*:/,
  ];
  if (forbiddenPatterns.some((pattern) => pattern.test(serialized))) {
    fail("privacy redaction");
  }
}

function assertExactKeys(
  value: JsonRecord,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    fail(`${label} keys`);
  }
}

function assertCanonicalRedactedValue(value: unknown, label: string): void {
  const source = record(value, label);
  assertExactKeys(source, ["type", "chars", "sha256", "nonEmpty"], label);
  redactedValue(source, label);
}

function assertCanonicalFixtureShape(fixture: JsonRecord): void {
  assertExactKeys(
    fixture,
    [
      "evidenceVersion",
      "sourceProduct",
      "source",
      "capture",
      "verification",
      "counts",
      "relationship",
      "timingCoverage",
      "schema",
      "textEvidence",
      "messageSamples",
      "toolSamples",
      "privacy",
      "evidenceSha256",
    ],
    "fixture",
  );

  const sourceProduct = record(fixture.sourceProduct, "fixture.sourceProduct");
  assertExactKeys(sourceProduct, ["name", "version"], "fixture.sourceProduct");
  literalString(sourceProduct.name, "trae-cn", "fixture.sourceProduct.name");
  literalString(
    sourceProduct.version,
    TRAE_STRUCTURED_RUNTIME_PRODUCT_VERSION,
    "fixture.sourceProduct.version",
  );

  const source = record(fixture.source, "fixture.source");
  assertExactKeys(
    source,
    [
      "kind",
      "serviceMethod",
      "endpoint",
      "service",
      "method",
      "environment",
    ],
    "fixture.source",
  );
  literalString(source.kind, "renderer-trae-api", "fixture.source.kind");
  literalString(
    source.serviceMethod,
    "TraeApi.chat.getMessages",
    "fixture.source.serviceMethod",
  );
  literalString(
    source.endpoint,
    "lite/get_messages",
    "fixture.source.endpoint",
  );
  literalString(source.service, "chat", "fixture.source.service");
  literalString(source.method, "getMessages", "fixture.source.method");
  literalString(source.environment, "local", "fixture.source.environment");

  const capture = record(fixture.capture, "fixture.capture");
  assertExactKeys(
    capture,
    ["probeStatus", "debugTransport", "sourceArtifactSha256"],
    "fixture.capture",
  );
  literalString(
    capture.probeStatus,
    "completed-with-transport-failure",
    "fixture.capture.probeStatus",
  );
  literalString(
    capture.debugTransport,
    "debug-server-blocked-by-csp",
    "fixture.capture.debugTransport",
  );
  normalizedHash(
    capture.sourceArtifactSha256,
    "fixture.capture.sourceArtifactSha256",
  );

  const verification = record(fixture.verification, "fixture.verification");
  assertExactKeys(
    verification,
    [
      "status",
      "sessionHash",
      "sessionSelectionSource",
      "loadedSessionCandidateCount",
      "pageCount",
    ],
    "fixture.verification",
  );
  literalString(
    verification.status,
    "verified",
    "fixture.verification.status",
  );
  normalizedHash(verification.sessionHash, "fixture.verification.sessionHash");
  literalString(
    verification.sessionSelectionSource,
    "v2-current-selection",
    "fixture.verification.sessionSelectionSource",
  );
  nonNegativeInteger(
    verification.loadedSessionCandidateCount,
    "fixture.verification.loadedSessionCandidateCount",
  );
  nonNegativeInteger(
    verification.pageCount,
    "fixture.verification.pageCount",
  );

  const counts = record(fixture.counts, "fixture.counts");
  assertExactKeys(
    counts,
    [
      "messages",
      "invalidMessageItems",
      "roles",
      "statuses",
      "messageTypes",
      "planItems",
      "toolCalls",
    ],
    "fixture.counts",
  );
  nonNegativeInteger(counts.messages, "fixture.counts.messages");
  nonNegativeInteger(
    counts.invalidMessageItems,
    "fixture.counts.invalidMessageItems",
  );
  countRecord(counts.roles, "fixture.counts.roles");
  countRecord(counts.statuses, "fixture.counts.statuses");
  countRecord(counts.messageTypes, "fixture.counts.messageTypes");
  nonNegativeInteger(counts.planItems, "fixture.counts.planItems");
  nonNegativeInteger(counts.toolCalls, "fixture.counts.toolCalls");

  const relationship = record(fixture.relationship, "fixture.relationship");
  assertExactKeys(
    relationship,
    ["samples", "matches", "verified"],
    "fixture.relationship",
  );
  nonNegativeInteger(relationship.samples, "fixture.relationship.samples");
  nonNegativeInteger(relationship.matches, "fixture.relationship.matches");
  booleanLiteral(
    relationship.verified,
    true,
    "fixture.relationship.verified",
  );

  const timing = record(fixture.timingCoverage, "fixture.timingCoverage");
  assertExactKeys(
    timing,
    ["createdAt", "chatStartTime", "chatEndTime"],
    "fixture.timingCoverage",
  );
  nonNegativeInteger(timing.createdAt, "fixture.timingCoverage.createdAt");
  nonNegativeInteger(
    timing.chatStartTime,
    "fixture.timingCoverage.chatStartTime",
  );
  nonNegativeInteger(
    timing.chatEndTime,
    "fixture.timingCoverage.chatEndTime",
  );

  const schemaRecord = record(fixture.schema, "fixture.schema");
  assertExactKeys(
    schemaRecord,
    Object.keys(REQUIRED_SCHEMA_KEYS),
    "fixture.schema",
  );
  schema(schemaRecord);

  const textEvidenceRecord = record(
    fixture.textEvidence,
    "fixture.textEvidence",
  );
  assertExactKeys(
    textEvidenceRecord,
    REQUIRED_TEXT_FIELDS,
    "fixture.textEvidence",
  );
  for (const field of REQUIRED_TEXT_FIELDS) {
    const fieldEvidence = record(
      textEvidenceRecord[field],
      `fixture.textEvidence.${field}`,
    );
    assertExactKeys(
      fieldEvidence,
      ["count", "nonEmpty", "totalChars", "sampleHashes"],
      `fixture.textEvidence.${field}`,
    );
    textEvidence(fieldEvidence, `fixture.textEvidence.${field}`);
  }

  if (!Array.isArray(fixture.messageSamples) || fixture.messageSamples.length === 0) {
    fail("fixture.messageSamples");
  }
  fixture.messageSamples.forEach((item, index) => {
    const sample = record(item, `fixture.messageSamples[${index}]`);
    assertExactKeys(
      sample,
      [
        "messageHash",
        "turnHash",
        "replyHash",
        "role",
        "status",
        "messageType",
        "messageIndex",
        "contentEvidence",
        "queryEvidence",
      ],
      `fixture.messageSamples[${index}]`,
    );
    normalizedHash(
      sample.messageHash,
      `fixture.messageSamples[${index}].messageHash`,
    );
    nullableHash(
      sample.turnHash,
      `fixture.messageSamples[${index}].turnHash`,
    );
    nullableHash(
      sample.replyHash,
      `fixture.messageSamples[${index}].replyHash`,
    );
    stringValue(sample.role, `fixture.messageSamples[${index}].role`);
    stringValue(sample.status, `fixture.messageSamples[${index}].status`);
    stringValue(
      sample.messageType,
      `fixture.messageSamples[${index}].messageType`,
    );
    nonNegativeInteger(
      sample.messageIndex,
      `fixture.messageSamples[${index}].messageIndex`,
    );
    assertCanonicalRedactedValue(
      sample.contentEvidence,
      `fixture.messageSamples[${index}].contentEvidence`,
    );
    assertCanonicalRedactedValue(
      sample.queryEvidence,
      `fixture.messageSamples[${index}].queryEvidence`,
    );
  });

  if (!Array.isArray(fixture.toolSamples) || fixture.toolSamples.length === 0) {
    fail("fixture.toolSamples");
  }
  fixture.toolSamples.forEach((item, index) => {
    const sample = record(item, `fixture.toolSamples[${index}]`);
    assertExactKeys(
      sample,
      [
        "toolCallHash",
        "nameEvidence",
        "paramsEvidence",
        "resultStatus",
        "resultDataEvidence",
        "resultErrorEvidence",
        "timingKeys",
      ],
      `fixture.toolSamples[${index}]`,
    );
    normalizedHash(
      sample.toolCallHash,
      `fixture.toolSamples[${index}].toolCallHash`,
    );
    assertCanonicalRedactedValue(
      sample.nameEvidence,
      `fixture.toolSamples[${index}].nameEvidence`,
    );
    assertCanonicalRedactedValue(
      sample.paramsEvidence,
      `fixture.toolSamples[${index}].paramsEvidence`,
    );
    stringValue(
      sample.resultStatus,
      `fixture.toolSamples[${index}].resultStatus`,
    );
    assertCanonicalRedactedValue(
      sample.resultDataEvidence,
      `fixture.toolSamples[${index}].resultDataEvidence`,
    );
    assertCanonicalRedactedValue(
      sample.resultErrorEvidence,
      `fixture.toolSamples[${index}].resultErrorEvidence`,
    );
    const timingKeys = stringArray(
      sample.timingKeys,
      `fixture.toolSamples[${index}].timingKeys`,
    );
    for (const requiredKey of REQUIRED_TOOL_TIMING_KEYS) {
      if (!timingKeys.includes(requiredKey)) {
        fail(
          `fixture.toolSamples[${index}].timingKeys missing ${requiredKey}`,
        );
      }
    }
  });

  const privacy = record(fixture.privacy, "fixture.privacy");
  assertExactKeys(
    privacy,
    [
      "rawIdentifiersIncluded",
      "rawTextIncluded",
      "rawPathsIncluded",
      "rawToolPayloadsIncluded",
    ],
    "fixture.privacy",
  );
  for (const key of Object.keys(privacy)) {
    booleanLiteral(privacy[key], false, `fixture.privacy.${key}`);
  }
}

export function normalizeTraeStructuredRuntimeEvidence(
  serializedProbe: string,
): TraeStructuredRuntimeEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedProbe);
  } catch {
    fail("probe JSON");
  }

  const probe = record(parsed, "probe");
  const probeStatus = literalString(
    probe.probeStatus,
    "completed-with-transport-failure",
    "probe.probeStatus",
  );
  const debugTransport = literalString(
    probe.transport,
    "debug-server-blocked-by-csp",
    "probe.transport",
  );
  const report = record(probe.report, "probe.report");
  const sourceProduct = record(report.sourceProduct, "report.sourceProduct");
  literalString(sourceProduct.name, "trae-cn", "sourceProduct.name");
  literalString(
    sourceProduct.version,
    TRAE_STRUCTURED_RUNTIME_PRODUCT_VERSION,
    "sourceProduct.version",
  );
  const source = record(report.source, "report.source");
  literalString(source.kind, "renderer-trae-api", "source.kind");
  literalString(source.service, "chat", "source.service");
  literalString(source.method, "getMessages", "source.method");
  literalString(source.environment, "local", "source.environment");

  const contentCoverage = record(
    report.contentCoverage,
    "report.contentCoverage",
  );
  const rawTextEvidence = record(
    contentCoverage.textEvidence,
    "contentCoverage.textEvidence",
  );
  const normalizedTextEvidence: Record<string, StructuredTextEvidence> = {};
  for (const field of REQUIRED_TEXT_FIELDS) {
    normalizedTextEvidence[field] = textEvidence(
      rawTextEvidence[field],
      `textEvidence.${field}`,
    );
  }

  const relationship = record(report.relationship, "report.relationship");
  const timingCoverage = record(
    report.timingCoverage,
    "report.timingCoverage",
  );
  const privacy = record(report.privacy, "report.privacy");

  const reportWithoutDigest: Omit<
    TraeStructuredRuntimeEvidence,
    "evidenceSha256"
  > = {
    evidenceVersion: 1,
    sourceProduct: {
      name: "trae-cn",
      version: TRAE_STRUCTURED_RUNTIME_PRODUCT_VERSION,
    },
    source: {
      kind: "renderer-trae-api",
      serviceMethod: "TraeApi.chat.getMessages",
      endpoint: "lite/get_messages",
      service: "chat",
      method: "getMessages",
      environment: "local",
    },
    capture: {
      probeStatus,
      debugTransport,
      sourceArtifactSha256: sha256(serializedProbe),
    },
    verification: {
      status: "verified",
      sessionHash: normalizedHash(report.sessionHash, "report.sessionHash"),
      sessionSelectionSource: literalString(
        report.sessionSelectionSource,
        "v2-current-selection",
        "report.sessionSelectionSource",
      ),
      loadedSessionCandidateCount: nonNegativeInteger(
        report.loadedSessionCandidateCount,
        "report.loadedSessionCandidateCount",
      ),
      pageCount: nonNegativeInteger(report.pageCount, "report.pageCount"),
    },
    counts: {
      messages: nonNegativeInteger(report.messageCount, "report.messageCount"),
      invalidMessageItems: nonNegativeInteger(
        report.invalidMessageItemCount,
        "report.invalidMessageItemCount",
      ),
      roles: countRecord(report.roleCounts, "report.roleCounts"),
      statuses: countRecord(report.statusCounts, "report.statusCounts"),
      messageTypes: countRecord(
        report.messageTypeCounts,
        "report.messageTypeCounts",
      ),
      planItems: nonNegativeInteger(
        contentCoverage.planItemCount,
        "contentCoverage.planItemCount",
      ),
      toolCalls: nonNegativeInteger(
        contentCoverage.toolCallCount,
        "contentCoverage.toolCallCount",
      ),
    },
    relationship: {
      samples: nonNegativeInteger(
        relationship.samples,
        "relationship.samples",
      ),
      matches: nonNegativeInteger(
        relationship.matches,
        "relationship.matches",
      ),
      verified: booleanLiteral(
        relationship.verified,
        true,
        "relationship.verified",
      ),
    },
    timingCoverage: {
      createdAt: nonNegativeInteger(
        timingCoverage.createdAt,
        "timingCoverage.createdAt",
      ),
      chatStartTime: nonNegativeInteger(
        timingCoverage.chatStartTime,
        "timingCoverage.chatStartTime",
      ),
      chatEndTime: nonNegativeInteger(
        timingCoverage.chatEndTime,
        "timingCoverage.chatEndTime",
      ),
    },
    schema: schema(report.schema),
    textEvidence: normalizedTextEvidence,
    messageSamples: messageSamples(report.messageSamples),
    toolSamples: toolSamples(contentCoverage.toolSamples),
    privacy: {
      rawIdentifiersIncluded: booleanLiteral(
        privacy.rawIdentifiersIncluded,
        false,
        "privacy.rawIdentifiersIncluded",
      ),
      rawTextIncluded: booleanLiteral(
        privacy.rawTextIncluded,
        false,
        "privacy.rawTextIncluded",
      ),
      rawPathsIncluded: booleanLiteral(
        privacy.rawPathsIncluded,
        false,
        "privacy.rawPathsIncluded",
      ),
      rawToolPayloadsIncluded: booleanLiteral(
        privacy.rawToolPayloadsIncluded,
        false,
        "privacy.rawToolPayloadsIncluded",
      ),
    },
  };

  assertStructuredCoverage(reportWithoutDigest);
  assertNoPrivateValues(reportWithoutDigest);
  return {
    ...reportWithoutDigest,
    evidenceSha256: sha256(JSON.stringify(reportWithoutDigest)),
  };
}

export function validateTraeStructuredRuntimeEvidence(
  value: unknown,
): TraeStructuredRuntimeEvidence {
  const fixture = record(value, "fixture");
  if (fixture.evidenceVersion !== 1) fail("fixture.evidenceVersion");
  assertCanonicalFixtureShape(fixture);
  const evidenceSha256 = normalizedHash(
    fixture.evidenceSha256,
    "fixture.evidenceSha256",
  );
  const { evidenceSha256: _ignored, ...reportWithoutDigest } = fixture;
  const expectedDigest = sha256(JSON.stringify(reportWithoutDigest));
  if (evidenceSha256 !== expectedDigest) fail("fixture.evidenceSha256");

  const typed = fixture as unknown as TraeStructuredRuntimeEvidence;
  assertStructuredCoverage(typed);
  assertNoPrivateValues(typed);
  return typed;
}
