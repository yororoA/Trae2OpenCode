import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import type { DiscoveredTraeRoot } from "../trae/path-discovery.js";
import {
  assessTraeSessionRecoverability,
  gradeSessionRecoveries,
  gradeSessionRecovery,
  type SessionMessageEvidence,
  type SessionRecoveryEvidence,
} from "../trae/recovery-grading.js";

const temporaryDirectories: string[] = [];

function completeEvidence(
  overrides: Partial<SessionRecoveryEvidence> = {},
): SessionRecoveryEvidence {
  return {
    workspaceStorageId: "workspace-a",
    sourceSessionId: "session-a",
    profileVerification: "verified",
    metadataAvailable: true,
    messageSource: "available",
    expectedMessageCount: 2,
    userMessages: 1,
    userMessagesWithText: 1,
    assistantMessages: 1,
    assistantMessagesWithContent: 1,
    assistantMessagesWithCompletionTime: 1,
    assistantMessagesLinkedToUser: 1,
    invalidMessages: 0,
    danglingReferences: 0,
    sourceCorrupt: false,
    ...overrides,
  };
}

function createRootWithSessions(): DiscoveredTraeRoot {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "trae-recovery-grading-"),
  );
  temporaryDirectories.push(root);
  const productDataPath = path.join(root, "Trae CN");
  const userDataPath = path.join(productDataPath, "User");
  const globalStoragePath = path.join(userDataPath, "globalStorage");
  const workspaceStoragePath = path.join(
    userDataPath,
    "workspaceStorage",
  );
  const workspacePath = path.join(
    workspaceStoragePath,
    "workspace-a",
  );
  const projectPath = path.join(root, "project");
  fs.mkdirSync(globalStoragePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(projectPath);
  fs.writeFileSync(
    path.join(workspacePath, "workspace.json"),
    JSON.stringify({
      folder: pathToFileURL(projectPath).href,
    }),
  );

  const database = new Database(
    path.join(workspacePath, "state.vscdb"),
  );
  try {
    database.exec(
      "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)",
    );
    const insert = database.prepare(
      "INSERT INTO ItemTable (key, value) VALUES (?, ?)",
    );
    insert.run("ai-chat-v2.lastActiveSessionId", "session-a");
    insert.run(
      "chat.ChatSessionStore.index",
      JSON.stringify({
        version: 1,
        entries: {
          "session-a": {},
          "session-b": {},
        },
      }),
    );
  } finally {
    database.close();
  }

  return {
    platform: "darwin",
    product: "trae-cn",
    source: "override",
    productDataPath,
    userDataPath,
    globalStoragePath,
    workspaceStoragePath,
    modularDataPath: path.join(productDataPath, "ModularData"),
    availability: {
      globalStorage: true,
      workspaceStorage: true,
      modularData: false,
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("gradeSessionRecovery", () => {
  it("grades a fully covered message chain as complete", () => {
    assert.deepStrictEqual(
      gradeSessionRecovery(completeEvidence()),
      {
        workspaceStorageId: "workspace-a",
        sourceSessionId: "session-a",
        recovery: "complete",
        missingReasons: [],
        counts: {
          expectedMessageCount: 2,
          userMessages: 1,
          userMessagesWithText: 1,
          assistantMessages: 1,
          assistantMessagesWithContent: 1,
          assistantMessagesWithCompletionTime: 1,
          assistantMessagesLinkedToUser: 1,
          invalidMessages: 0,
        },
      },
    );
  });

  it("grades recoverable content with explicit gaps as partial", () => {
    const result = gradeSessionRecovery(
      completeEvidence({
        expectedMessageCount: 4,
        userMessages: 2,
        userMessagesWithText: 2,
        assistantMessages: 2,
        assistantMessagesWithContent: 1,
        assistantMessagesWithCompletionTime: 1,
        assistantMessagesLinkedToUser: 1,
      }),
    );

    assert.equal(result.recovery, "partial");
    assert.deepStrictEqual(
      result.missingReasons.map((reason) => reason.code),
      [
        "T2O_RECOVERY_ASSISTANT_CONTENT_MISSING",
        "T2O_RECOVERY_ASSISTANT_COMPLETION_TIME_MISSING",
        "T2O_RECOVERY_REPLY_RELATION_MISSING",
      ],
    );
  });

  it("keeps sessions metadata-only when structured messages are unavailable", () => {
    const result = gradeSessionRecovery(
      completeEvidence({
        messageSource: "unavailable",
        expectedMessageCount: undefined,
        userMessages: 0,
        userMessagesWithText: 0,
        assistantMessages: 0,
        assistantMessagesWithContent: 0,
        assistantMessagesWithCompletionTime: 0,
        assistantMessagesLinkedToUser: 0,
      }),
    );

    assert.equal(result.recovery, "metadata-only");
    assert.deepStrictEqual(
      result.missingReasons.map((reason) => reason.code),
      [
        "T2O_RECOVERY_MESSAGE_SOURCE_UNAVAILABLE",
        "T2O_RECOVERY_MESSAGE_COUNT_UNKNOWN",
        "T2O_RECOVERY_USER_MESSAGES_MISSING",
        "T2O_RECOVERY_ASSISTANT_MESSAGES_MISSING",
      ],
    );
  });

  it("does not promote content from an unsupported profile", () => {
    const result = gradeSessionRecovery(
      completeEvidence({
        profileVerification: "unsupported",
      }),
    );

    assert.equal(result.recovery, "metadata-only");
    assert.deepStrictEqual(
      result.missingReasons.map((reason) => reason.code),
      ["T2O_RECOVERY_PROFILE_UNSUPPORTED"],
    );
  });

  it("grades corrupt source evidence as unrecoverable", () => {
    const result = gradeSessionRecovery(
      completeEvidence({
        sourceCorrupt: true,
        invalidMessages: 1,
        expectedMessageCount: 3,
      }),
    );

    assert.equal(result.recovery, "unrecoverable");
    assert.deepStrictEqual(
      result.missingReasons.map((reason) => reason.code),
      [
        "T2O_RECOVERY_INVALID_MESSAGES",
        "T2O_RECOVERY_SOURCE_CORRUPT",
      ],
    );
  });

  it("rejects inconsistent counts and duplicate session identities", () => {
    assert.throws(
      () =>
        gradeSessionRecovery(
          completeEvidence({
            userMessages: 0,
            userMessagesWithText: 1,
          }),
        ),
      (error) => {
        assert.ok(error instanceof Trae2OpenCodeError);
        assert.equal(error.code, "T2O_TRAE_RECOVERY_EVIDENCE_INVALID");
        return true;
      },
    );
    assert.throws(
      () =>
        gradeSessionRecoveries([
          completeEvidence(),
          completeEvidence(),
        ]),
      (error) => {
        assert.ok(error instanceof Trae2OpenCodeError);
        assert.equal(error.code, "T2O_TRAE_RECOVERY_EVIDENCE_INVALID");
        return true;
      },
    );
  });
});

describe("assessTraeSessionRecoverability", () => {
  it("discovers every metadata session and grades it without content", async () => {
    const root = createRootWithSessions();
    const report = await assessTraeSessionRecoverability({
      root,
      productVersion: "3.3.104",
      temporaryRoot: path.join(
        path.dirname(root.productDataPath),
        "snapshots",
      ),
    });

    assert.deepStrictEqual(
      report.sessions.map((session) => session.sourceSessionId),
      ["session-a", "session-b"],
    );
    assert.deepStrictEqual(report.recoveryCounts, {
      complete: 0,
      partial: 0,
      "metadata-only": 2,
      unrecoverable: 0,
    });
    assert.ok(
      report.sessions.every(
        (session) =>
          session.recovery === "metadata-only" &&
          session.missingReasons.some(
            (reason) =>
              reason.code ===
              "T2O_RECOVERY_MESSAGE_SOURCE_UNAVAILABLE",
          ),
      ),
    );
    assert.equal(
      JSON.stringify(report).includes(
        path.dirname(root.productDataPath),
      ),
      false,
    );
  });

  it("uses supplied message evidence to grade complete and partial sessions", async () => {
    const root = createRootWithSessions();
    const completeMessageEvidence: SessionMessageEvidence = {
      expectedMessageCount: 2,
      userMessages: 1,
      userMessagesWithText: 1,
      assistantMessages: 1,
      assistantMessagesWithContent: 1,
      assistantMessagesWithCompletionTime: 1,
      assistantMessagesLinkedToUser: 1,
      invalidMessages: 0,
      danglingReferences: 0,
      sourceCorrupt: false,
    };
    const report = await assessTraeSessionRecoverability({
      root,
      productVersion: "3.3.104",
      runtimeProbe: () => true,
      sessionEvidenceProvider({ sourceSessionId }) {
        if (sourceSessionId === "session-a") {
          return completeMessageEvidence;
        }
        return {
          ...completeMessageEvidence,
          assistantMessagesWithCompletionTime: 0,
        };
      },
    });

    assert.deepStrictEqual(
      report.sessions.map((session) => [
        session.sourceSessionId,
        session.recovery,
      ]),
      [
        ["session-a", "complete"],
        ["session-b", "partial"],
      ],
    );
    assert.deepStrictEqual(report.recoveryCounts, {
      complete: 1,
      partial: 1,
      "metadata-only": 0,
      unrecoverable: 0,
    });
  });

  it("isolates evidence provider failures without leaking the error", async () => {
    const root = createRootWithSessions();
    const report = await assessTraeSessionRecoverability({
      root,
      productVersion: "3.3.104",
      sessionEvidenceProvider() {
        throw new Error("private session body");
      },
    });

    assert.deepStrictEqual(report.recoveryCounts, {
      complete: 0,
      partial: 0,
      "metadata-only": 2,
      unrecoverable: 0,
    });
    assert.equal(
      report.issues.filter(
        (issue) =>
          issue.code ===
          "T2O_TRAE_SESSION_EVIDENCE_PROVIDER_FAILED",
      ).length,
      2,
    );
    assert.doesNotMatch(JSON.stringify(report), /private session body/);
  });
});
