import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readBundleFile } from "../../migration/bundle-file.js";
import type { TraeSessionMetadata } from "../../source/trae/session-metadata.js";
import {
  buildSessionChoices,
  bundleMatchesSession,
  cliJsonResult,
  formatMetadataStatus,
  parseChoiceIndex,
  resolveMigrationDirectories,
  sessionsForWorkspace,
} from "../interactive-migrate.js";

function session(
  sourceSessionId: string,
  metadataStatus: TraeSessionMetadata["metadataStatus"],
  workspaceStorageIds: string[] = [],
): TraeSessionMetadata {
  return {
    sourceSessionId,
    metadataStatus,
    workspaceStorageIds,
    sources: [],
  };
}

describe("interactive migration helpers", () => {
  it("parses only visible one-based choices within the list", () => {
    assert.equal(parseChoiceIndex("1", 3), 0);
    assert.equal(parseChoiceIndex(" 3 ", 3), 2);
    assert.equal(parseChoiceIndex("0", 3), undefined);
    assert.equal(parseChoiceIndex("4", 3), undefined);
    assert.equal(parseChoiceIndex("abc", 3), undefined);
  });

  it("reads the final structured CLI result without exposing progress text", () => {
    assert.deepEqual(
      cliJsonResult('progress\n{"ready":1,"blocked":0}\n'),
      { ready: 1, blocked: 0 },
    );
    assert.equal(cliJsonResult("progress only"), undefined);
  });

  it("labels metadata status without presenting it as final recovery", () => {
    assert.equal(formatMetadataStatus("complete"), "元数据完整");
    assert.equal(formatMetadataStatus("partial"), "元数据部分可用");
    assert.equal(formatMetadataStatus("invalid"), "元数据有问题");
    assert.equal(formatMetadataStatus("other"), "元数据状态未知");
  });

  it("builds readable session choices from runtime metadata", () => {
    const choices = buildSessionChoices(
      [session("session-a", "partial"), session("session-b", "complete")],
      [{
        chat_session_id: "session-a",
        title: "  Project   notes ",
        updated_at: "1724939164000",
      }],
    );

    assert.deepEqual(choices, [
      {
        id: "session-a",
        title: "Project notes",
        metadataStatus: "元数据部分可用",
        updatedAt: 1724939164000,
      },
      {
        id: "session-b",
        title: "未命名会话",
        metadataStatus: "元数据完整",
        updatedAt: undefined,
      },
    ]);
  });

  it("shows only sessions indexed by the selected workbench workspace", () => {
    const sessions = [
      session("session-a", "complete", ["workspace-a"]),
      session("session-b", "partial", ["workspace-b"]),
      session("session-shared", "complete", ["workspace-a", "workspace-b"]),
      session("session-global", "complete"),
    ];

    assert.deepEqual(
      sessionsForWorkspace(sessions, "workspace-a").map((item) => item.sourceSessionId),
      ["session-a", "session-shared"],
    );
    assert.deepEqual(
      sessionsForWorkspace(sessions, "workspace-b").map((item) => item.sourceSessionId),
      ["session-b", "session-shared"],
    );
  });

  it("uses stable opaque directories per selected session", () => {
    const root = "/tmp/trae2opencode";
    const first = resolveMigrationDirectories(root, "session-a");
    const same = resolveMigrationDirectories(root, "session-a");
    const second = resolveMigrationDirectories(root, "session-b");

    assert.deepEqual(first, same);
    assert.notEqual(first.exportDirectory, second.exportDirectory);
    assert.match(first.exportDirectory, /trae-export\/session-[a-f0-9]{16}$/);
    assert.doesNotMatch(first.exportDirectory, /session-a/);
    assert.deepEqual(
      resolveMigrationDirectories(root, "session-a", "/tmp/export", "/tmp/run"),
      { exportDirectory: "/tmp/export", runDirectory: "/tmp/run" },
    );
  });

  it("accepts only a single bundle for the selected session", async () => {
    const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
    const sourceSessionId = bundle.sessions[0].sourceId;

    assert.equal(bundleMatchesSession(bundle, sourceSessionId), true);
    assert.equal(bundleMatchesSession(bundle, "different-session"), false);
  });
});
