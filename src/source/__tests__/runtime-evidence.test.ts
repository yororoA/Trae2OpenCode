import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectTraeRuntimeEvidence } from "../trae/runtime-evidence";

const SESSION_ID = "session-private";
const PRODUCT_VERSION = "3.3.104";
const LOG = [
  `2026-09-23T09:00:00.000+08:00 [info] [stream-diagnostics][init] history messages loaded {"sessionId":"${SESSION_ID}","loadedMessageCount":20,"pendingMessageCount":0,"planItemCount":12,"storeMessageCount":20,"hasMore":true}`,
  `2026-09-23T09:00:01.000+08:00 [info] [MetadataHandler] received metadata {"sessionId":"${SESSION_ID}","message_id":"assistant-1","turn_id":"turn-1","message_type":"task","message_index":22,"status":"in_progress","reply_to_message_id":"user-1","user_message_context":{"query":"private content"}}`,
  `2026-09-23T09:00:01.100+08:00 [info] [stream-diagnostics][metadata] metadata applied {"sessionId":"${SESSION_ID}","agentMessageId":"assistant-1","userMessageId":"user-1"}`,
  `2026-09-23T09:00:02.000+08:00 [info] [MetadataHandler] received metadata {"sessionId":"${SESSION_ID}","message_id":"assistant-2","turn_id":"turn-2","message_type":"task","message_index":24,"status":"in_progress","reply_to_message_id":"user-2"}`,
  `2026-09-23T09:00:02.100+08:00 [info] [stream-diagnostics][metadata] metadata applied {"sessionId":"${SESSION_ID}","agentMessageId":"assistant-2","userMessageId":"user-2"}`,
  `2026-09-23T09:00:03.000+08:00 [info] [ai-chat/v2][Realtime] event: background_command_status_changed {"session_id":"${SESSION_ID}","tool_call_id":"tool-1","result":{"status":"Running","output_path":"/Users/private/output.log"}}`,
  `2026-09-23T09:00:04.000+08:00 [info] [ai-chat/v2][Realtime] event: background_command_status_changed {"session_id":"${SESSION_ID}","tool_call_id":"tool-1","result":{"status":"Exited","exit_code":0,"output_path":"/Users/private/output.log"}}`,
].join("\n");

describe("collectTraeRuntimeEvidence", () => {
  it("extracts relationships and tool transitions without message content", () => {
    const result = collectTraeRuntimeEvidence(
      LOG,
      SESSION_ID,
      PRODUCT_VERSION,
    );

    assert.equal(result.verification.status, "partial");
    assert.equal(result.history.observations[0].loadedMessageCount, 20);
    assert.equal(result.history.planItemsObserved, true);
    assert.equal(result.turns.roleProjectionVerified, true);
    assert.equal(result.turns.replyAssociationVerified, true);
    assert.equal(result.turns.turnAssociationVerified, true);
    assert.equal(result.turns.messageIndicesStrictlyIncreasing, true);
    assert.deepEqual(result.tools.statusValues, ["Exited", "Running"]);
    assert.equal(result.tools.pairedCalls, 1);
    assert.equal(result.tools.samples[0].exitKind, "success");
  });

  it("does not retain raw IDs, content, account fields, or absolute paths", () => {
    const serialized = JSON.stringify(
      collectTraeRuntimeEvidence(LOG, SESSION_ID, PRODUCT_VERSION),
    );

    for (const forbidden of [
      SESSION_ID,
      "assistant-1",
      "user-1",
      "turn-1",
      "tool-1",
      "private content",
      "/Users/",
      "output.log",
      "user_message_context",
    ]) {
      assert.ok(!serialized.includes(forbidden), `leaked ${forbidden}`);
    }
  });

  it("rejects logs without an observed get_messages readback", () => {
    assert.throws(
      () =>
        collectTraeRuntimeEvidence(
          "unrelated log",
          SESSION_ID,
          PRODUCT_VERSION,
        ),
      /No get_messages runtime readback/,
    );
  });

  it("rejects evidence from an unsupported product version", () => {
    assert.throws(
      () => collectTraeRuntimeEvidence(LOG, SESSION_ID, "3.4.0"),
      /Unsupported TRAE runtime evidence version: 3\.4\.0/,
    );
  });
});
