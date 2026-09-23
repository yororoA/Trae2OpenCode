import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeTraeStructuredRuntimeEvidence,
  validateTraeStructuredRuntimeEvidence,
} from "../trae/structured-runtime-evidence";

const hash = (character: string): string => character.repeat(64);
const valueEvidence = (character: string) => ({
  type: "string",
  chars: 12,
  sha256: hash(character),
  nonEmpty: true,
});

function createProbe(): Record<string, unknown> {
  return {
    probeStatus: "completed-with-transport-failure",
    transport: "debug-server-blocked-by-csp",
    report: {
      sourceProduct: { name: "trae-cn", version: "3.3.104" },
      source: {
        kind: "renderer-trae-api",
        service: "chat",
        method: "getMessages",
        environment: "local",
      },
      sessionHash: hash("a"),
      sessionSelectionSource: "v2-current-selection",
      loadedSessionCandidateCount: 1,
      pageCount: 1,
      messageCount: 2,
      invalidMessageItemCount: 0,
      roleCounts: { user: 1, assistant: 1 },
      statusCounts: { completed: 1, other: 1 },
      messageTypeCounts: { general: 1, task: 1 },
      relationship: { samples: 1, matches: 1, verified: true },
      timingCoverage: {
        createdAt: 2,
        chatStartTime: 1,
        chatEndTime: 1,
      },
      schema: {
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
      },
      contentCoverage: {
        textEvidence: {
          "user.query": {
            count: 1,
            nonEmpty: 1,
            totalChars: 12,
            sampleHashes: [hash("b")],
          },
          "user.content": {
            count: 1,
            nonEmpty: 1,
            totalChars: 12,
            sampleHashes: [hash("c")],
          },
          "planItem.thought": {
            count: 1,
            nonEmpty: 1,
            totalChars: 12,
            sampleHashes: [hash("d")],
          },
          "planItem.reasoning_content": {
            count: 1,
            nonEmpty: 1,
            totalChars: 12,
            sampleHashes: [hash("e")],
          },
        },
        planItemCount: 1,
        toolCallCount: 1,
        toolSamples: [
          {
            idHash: hash("f"),
            name: valueEvidence("1"),
            params: { ...valueEvidence("2"), type: "object" },
            resultStatus: "success",
            resultData: { ...valueEvidence("3"), type: "object" },
            resultError: {
              type: "string",
              chars: 0,
              sha256: hash("4"),
              nonEmpty: false,
            },
            timingKeys: [
              "generated_at_ms",
              "tool_call_started_at_ms",
              "tool_call_finished_at_ms",
            ],
          },
        ],
      },
      messageSamples: [
        {
          messageHash: hash("5"),
          turnHash: null,
          replyHash: null,
          role: "user",
          status: "other",
          messageType: "general",
          messageIndex: 1,
          content: valueEvidence("6"),
          query: valueEvidence("7"),
        },
        {
          messageHash: hash("8"),
          turnHash: hash("9"),
          replyHash: hash("5"),
          role: "assistant",
          status: "completed",
          messageType: "task",
          messageIndex: 2,
          content: valueEvidence("a"),
          query: {
            type: "undefined",
            chars: 9,
            sha256: hash("b"),
            nonEmpty: true,
          },
        },
      ],
      privacy: {
        rawIdentifiersIncluded: false,
        rawTextIncluded: false,
        rawPathsIncluded: false,
        rawToolPayloadsIncluded: false,
      },
      rawPrivateText: "must not be copied",
      message_id: "must-not-be-copied",
      params: { path: "/Users/private/file" },
    },
  };
}

describe("normalizeTraeStructuredRuntimeEvidence", () => {
  it("normalizes a complete V2 report without retaining raw values", () => {
    const serializedProbe = JSON.stringify(createProbe());
    const result = normalizeTraeStructuredRuntimeEvidence(serializedProbe);
    const serializedResult = JSON.stringify(result);

    assert.equal(result.verification.status, "verified");
    assert.equal(result.source.serviceMethod, "TraeApi.chat.getMessages");
    assert.equal(result.counts.messages, 2);
    assert.equal(result.relationship.verified, true);
    assert.equal(result.textEvidence["planItem.reasoning_content"].nonEmpty, 1);
    assert.equal(result.toolSamples[0].resultStatus, "success");
    assert.match(result.evidenceSha256, /^sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(
      serializedResult,
      /must not be copied|must-not-be-copied|\/Users\/private/,
    );
    assert.deepEqual(validateTraeStructuredRuntimeEvidence(result), result);
  });

  it("rejects an unsupported product version", () => {
    const probe = createProbe() as {
      report: { sourceProduct: { version: string } };
    };
    probe.report.sourceProduct.version = "3.4.0";

    assert.throws(
      () => normalizeTraeStructuredRuntimeEvidence(JSON.stringify(probe)),
      /sourceProduct\.version/,
    );
  });

  it("rejects reports missing required schema fields", () => {
    const probe = createProbe() as {
      report: { schema: { planItemKeys: string[] } };
    };
    probe.report.schema.planItemKeys = ["id", "thought"];

    assert.throws(
      () => normalizeTraeStructuredRuntimeEvidence(JSON.stringify(probe)),
      /schema\.planItemKeys missing reasoning_content/,
    );
  });

  it("rejects reports without a sampled user-assistant relation", () => {
    const probe = createProbe() as {
      report: { messageSamples: Array<{ role: string; replyHash: string }> };
    };
    probe.report.messageSamples[1].replyHash = hash("c");

    assert.throws(
      () => normalizeTraeStructuredRuntimeEvidence(JSON.stringify(probe)),
      /messageSamples assistant relation/,
    );
  });

  it("rejects a fixture whose canonical digest was modified", () => {
    const fixture = normalizeTraeStructuredRuntimeEvidence(
      JSON.stringify(createProbe()),
    );
    fixture.counts.messages += 1;

    assert.throws(
      () => validateTraeStructuredRuntimeEvidence(fixture),
      /fixture\.evidenceSha256/,
    );
  });

  it("rejects extra canonical fixture fields before they can carry raw data", () => {
    const fixture = {
      ...normalizeTraeStructuredRuntimeEvidence(JSON.stringify(createProbe())),
      rawText: "private content",
    };

    assert.throws(
      () => validateTraeStructuredRuntimeEvidence(fixture),
      /fixture keys/,
    );
  });
});
