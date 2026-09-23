import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { RecoveryGrade } from "../../ir/types.js";
import { ERROR_DEFINITIONS } from "../../shared/error-codes.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  probeTraeCapabilities,
  type CapabilityProbeIssue,
  type CapabilityVerification,
  type TraeCapabilityProbeOptions,
  type TraeCapabilityReport,
} from "./capability-probe.js";
import { withReadonlySqliteSnapshot } from "./sqlite-snapshot.js";
import { resolveTraeWorkspaces } from "./workspace-resolution.js";

export type MessageSourceStatus =
  | "available"
  | "unavailable"
  | "error";

export type RecoveryReasonCode =
  | "T2O_RECOVERY_PROFILE_UNVERIFIED"
  | "T2O_RECOVERY_PROFILE_UNSUPPORTED"
  | "T2O_RECOVERY_METADATA_MISSING"
  | "T2O_RECOVERY_MESSAGE_SOURCE_UNAVAILABLE"
  | "T2O_RECOVERY_MESSAGE_SOURCE_ERROR"
  | "T2O_RECOVERY_MESSAGE_COUNT_UNKNOWN"
  | "T2O_RECOVERY_MESSAGE_COUNT_MISMATCH"
  | "T2O_RECOVERY_USER_MESSAGES_MISSING"
  | "T2O_RECOVERY_USER_TEXT_MISSING"
  | "T2O_RECOVERY_ASSISTANT_MESSAGES_MISSING"
  | "T2O_RECOVERY_ASSISTANT_CONTENT_MISSING"
  | "T2O_RECOVERY_ASSISTANT_COMPLETION_TIME_MISSING"
  | "T2O_RECOVERY_REPLY_RELATION_MISSING"
  | "T2O_RECOVERY_INVALID_MESSAGES"
  | "T2O_RECOVERY_DANGLING_REFERENCES"
  | "T2O_RECOVERY_SOURCE_CORRUPT";

export interface SessionMessageEvidence {
  expectedMessageCount?: number;
  userMessages: number;
  userMessagesWithText: number;
  assistantMessages: number;
  assistantMessagesWithContent: number;
  assistantMessagesWithCompletionTime: number;
  assistantMessagesLinkedToUser: number;
  invalidMessages: number;
  danglingReferences: number;
  sourceCorrupt: boolean;
}

export interface SessionRecoveryEvidence extends SessionMessageEvidence {
  workspaceStorageId: string;
  sourceSessionId: string;
  profileVerification: CapabilityVerification;
  metadataAvailable: boolean;
  messageSource: MessageSourceStatus;
}

export interface RecoveryReason {
  code: RecoveryReasonCode;
  message: string;
}

export interface SessionRecoveryAssessment {
  workspaceStorageId: string;
  sourceSessionId: string;
  recovery: RecoveryGrade;
  missingReasons: RecoveryReason[];
  counts: Omit<
    SessionMessageEvidence,
    "sourceCorrupt" | "danglingReferences"
  >;
}

export interface SessionEvidenceContext {
  workspaceStorageId: string;
  sourceSessionId: string;
}

export type SessionEvidenceProvider = (
  context: SessionEvidenceContext,
) =>
  | SessionMessageEvidence
  | null
  | Promise<SessionMessageEvidence | null>;

export interface TraeSessionRecoveryOptions
  extends TraeCapabilityProbeOptions {
  sessionEvidenceProvider?: SessionEvidenceProvider;
}

export interface SessionRecoveryIssue {
  code: `T2O_${string}`;
  severity: "warning" | "error";
  message: string;
  workspaceStorageId?: string;
  sourceSessionId?: string;
}

export interface TraeSessionRecoveryReport {
  reportVersion: 1;
  capabilities: TraeCapabilityReport;
  sessions: SessionRecoveryAssessment[];
  recoveryCounts: Record<RecoveryGrade, number>;
  issues: SessionRecoveryIssue[];
}

const RECOVERY_REASON_MESSAGES: Record<
  RecoveryReasonCode,
  string
> = {
  T2O_RECOVERY_PROFILE_UNVERIFIED:
    "The source storage profile is not verified.",
  T2O_RECOVERY_PROFILE_UNSUPPORTED:
    "The source storage profile is unsupported.",
  T2O_RECOVERY_METADATA_MISSING:
    "Required session metadata is missing.",
  T2O_RECOVERY_MESSAGE_SOURCE_UNAVAILABLE:
    "The structured message source is unavailable.",
  T2O_RECOVERY_MESSAGE_SOURCE_ERROR:
    "The structured message source failed.",
  T2O_RECOVERY_MESSAGE_COUNT_UNKNOWN:
    "The expected message count is unknown.",
  T2O_RECOVERY_MESSAGE_COUNT_MISMATCH:
    "The recovered message count does not match the source.",
  T2O_RECOVERY_USER_MESSAGES_MISSING:
    "No user messages were recovered.",
  T2O_RECOVERY_USER_TEXT_MISSING:
    "One or more user messages are missing text.",
  T2O_RECOVERY_ASSISTANT_MESSAGES_MISSING:
    "No assistant messages were recovered.",
  T2O_RECOVERY_ASSISTANT_CONTENT_MISSING:
    "One or more assistant messages are missing content.",
  T2O_RECOVERY_ASSISTANT_COMPLETION_TIME_MISSING:
    "One or more assistant messages are missing completion time.",
  T2O_RECOVERY_REPLY_RELATION_MISSING:
    "One or more assistant messages are missing reply relations.",
  T2O_RECOVERY_INVALID_MESSAGES:
    "One or more source messages are invalid.",
  T2O_RECOVERY_DANGLING_REFERENCES:
    "One or more source references are dangling.",
  T2O_RECOVERY_SOURCE_CORRUPT:
    "The source session data is corrupt.",
};

const REASON_ORDER = Object.keys(
  RECOVERY_REASON_MESSAGES,
) as RecoveryReasonCode[];
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function isNonNegativeInteger(value: number | undefined): boolean {
  return (
    value === undefined ||
    (Number.isInteger(value) && value >= 0)
  );
}

function validateEvidence(evidence: SessionRecoveryEvidence): void {
  const counts = [
    evidence.expectedMessageCount,
    evidence.userMessages,
    evidence.userMessagesWithText,
    evidence.assistantMessages,
    evidence.assistantMessagesWithContent,
    evidence.assistantMessagesWithCompletionTime,
    evidence.assistantMessagesLinkedToUser,
    evidence.invalidMessages,
    evidence.danglingReferences,
  ];
  const hasInvalidCount = counts.some(
    (count) => !isNonNegativeInteger(count),
  );
  const hasInvalidRelationship =
    evidence.userMessagesWithText > evidence.userMessages ||
    evidence.assistantMessagesWithContent >
      evidence.assistantMessages ||
    evidence.assistantMessagesWithCompletionTime >
      evidence.assistantMessages ||
    evidence.assistantMessagesLinkedToUser >
      evidence.assistantMessages;
  const hasInvalidIdentity =
    evidence.workspaceStorageId.length === 0 ||
    evidence.sourceSessionId.length === 0;

  if (
    hasInvalidCount ||
    hasInvalidRelationship ||
    hasInvalidIdentity
  ) {
    throw new Trae2OpenCodeError(
      "T2O_TRAE_RECOVERY_EVIDENCE_INVALID",
    );
  }
}

function collectMissingReasonCodes(
  evidence: SessionRecoveryEvidence,
): Set<RecoveryReasonCode> {
  const reasons = new Set<RecoveryReasonCode>();

  if (evidence.profileVerification === "unverified") {
    reasons.add("T2O_RECOVERY_PROFILE_UNVERIFIED");
  } else if (evidence.profileVerification === "unsupported") {
    reasons.add("T2O_RECOVERY_PROFILE_UNSUPPORTED");
  }
  if (!evidence.metadataAvailable) {
    reasons.add("T2O_RECOVERY_METADATA_MISSING");
  }
  if (evidence.messageSource === "unavailable") {
    reasons.add("T2O_RECOVERY_MESSAGE_SOURCE_UNAVAILABLE");
  } else if (evidence.messageSource === "error") {
    reasons.add("T2O_RECOVERY_MESSAGE_SOURCE_ERROR");
  }

  const recoveredMessageCount =
    evidence.userMessages +
    evidence.assistantMessages +
    evidence.invalidMessages;
  if (evidence.expectedMessageCount === undefined) {
    reasons.add("T2O_RECOVERY_MESSAGE_COUNT_UNKNOWN");
  } else if (evidence.expectedMessageCount !== recoveredMessageCount) {
    reasons.add("T2O_RECOVERY_MESSAGE_COUNT_MISMATCH");
  }
  if (evidence.userMessages === 0) {
    reasons.add("T2O_RECOVERY_USER_MESSAGES_MISSING");
  } else if (evidence.userMessagesWithText < evidence.userMessages) {
    reasons.add("T2O_RECOVERY_USER_TEXT_MISSING");
  }
  if (evidence.assistantMessages === 0) {
    reasons.add("T2O_RECOVERY_ASSISTANT_MESSAGES_MISSING");
  } else {
    if (
      evidence.assistantMessagesWithContent <
      evidence.assistantMessages
    ) {
      reasons.add("T2O_RECOVERY_ASSISTANT_CONTENT_MISSING");
    }
    if (
      evidence.assistantMessagesWithCompletionTime <
      evidence.assistantMessages
    ) {
      reasons.add(
        "T2O_RECOVERY_ASSISTANT_COMPLETION_TIME_MISSING",
      );
    }
    if (
      evidence.assistantMessagesLinkedToUser <
      evidence.assistantMessages
    ) {
      reasons.add("T2O_RECOVERY_REPLY_RELATION_MISSING");
    }
  }
  if (evidence.invalidMessages > 0) {
    reasons.add("T2O_RECOVERY_INVALID_MESSAGES");
  }
  if (evidence.danglingReferences > 0) {
    reasons.add("T2O_RECOVERY_DANGLING_REFERENCES");
  }
  if (evidence.sourceCorrupt) {
    reasons.add("T2O_RECOVERY_SOURCE_CORRUPT");
  }

  return reasons;
}

export function gradeSessionRecovery(
  evidence: SessionRecoveryEvidence,
): SessionRecoveryAssessment {
  validateEvidence(evidence);
  const reasonCodes = collectMissingReasonCodes(evidence);
  const hasPartialContent =
    evidence.profileVerification === "verified" &&
    evidence.messageSource === "available" &&
    evidence.userMessagesWithText > 0 &&
    evidence.assistantMessagesWithContent > 0;

  let recovery: RecoveryGrade;
  if (reasonCodes.size === 0) {
    recovery = "complete";
  } else if (evidence.sourceCorrupt) {
    recovery = "unrecoverable";
  } else if (hasPartialContent) {
    recovery = "partial";
  } else if (evidence.metadataAvailable) {
    recovery = "metadata-only";
  } else {
    recovery = "unrecoverable";
  }

  return {
    workspaceStorageId: evidence.workspaceStorageId,
    sourceSessionId: evidence.sourceSessionId,
    recovery,
    missingReasons: REASON_ORDER.filter((code) =>
      reasonCodes.has(code),
    ).map((code) => ({
      code,
      message: RECOVERY_REASON_MESSAGES[code],
    })),
    counts: {
      ...(evidence.expectedMessageCount === undefined
        ? {}
        : { expectedMessageCount: evidence.expectedMessageCount }),
      userMessages: evidence.userMessages,
      userMessagesWithText: evidence.userMessagesWithText,
      assistantMessages: evidence.assistantMessages,
      assistantMessagesWithContent:
        evidence.assistantMessagesWithContent,
      assistantMessagesWithCompletionTime:
        evidence.assistantMessagesWithCompletionTime,
      assistantMessagesLinkedToUser:
        evidence.assistantMessagesLinkedToUser,
      invalidMessages: evidence.invalidMessages,
    },
  };
}

export function gradeSessionRecoveries(
  evidenceItems: readonly SessionRecoveryEvidence[],
): SessionRecoveryAssessment[] {
  const identities = new Set<string>();
  return evidenceItems.map((evidence) => {
    const identity = JSON.stringify([
      evidence.workspaceStorageId,
      evidence.sourceSessionId,
    ]);
    if (identities.has(identity)) {
      throw new Trae2OpenCodeError(
        "T2O_TRAE_RECOVERY_EVIDENCE_INVALID",
      );
    }
    identities.add(identity);
    return gradeSessionRecovery(evidence);
  });
}

function safeIsFile(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

function toText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
}

function isValidSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

function readSessionIds(databasePath: string): {
  sessionIds: string[];
  invalid: boolean;
} {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma("query_only = ON");
    const selectValue = database.prepare(
      "SELECT value FROM ItemTable WHERE key = ?",
    );
    const sessionIds = new Set<string>();
    let invalid = false;

    const activeRow = selectValue.get(
      "ai-chat-v2.lastActiveSessionId",
    ) as { value: unknown } | undefined;
    if (activeRow) {
      const activeSessionId = toText(activeRow.value);
      if (activeSessionId && isValidSessionId(activeSessionId)) {
        sessionIds.add(activeSessionId);
      } else {
        invalid = true;
      }
    }

    const indexRow = selectValue.get(
      "chat.ChatSessionStore.index",
    ) as { value: unknown } | undefined;
    if (indexRow) {
      const serializedIndex = toText(indexRow.value);
      try {
        const parsed = serializedIndex
          ? (JSON.parse(serializedIndex) as unknown)
          : null;
        const entries =
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>).entries
            : null;
        if (
          entries === null ||
          typeof entries !== "object" ||
          Array.isArray(entries)
        ) {
          invalid = true;
        } else {
          for (const sourceSessionId of Object.keys(entries)) {
            if (isValidSessionId(sourceSessionId)) {
              sessionIds.add(sourceSessionId);
            } else {
              invalid = true;
            }
          }
        }
      } catch {
        invalid = true;
      }
    }

    return {
      sessionIds: [...sessionIds].sort(),
      invalid,
    };
  } finally {
    database.close();
  }
}

function emptyMessageEvidence(
  messageSource: MessageSourceStatus,
): Omit<
  SessionRecoveryEvidence,
  | "workspaceStorageId"
  | "sourceSessionId"
  | "profileVerification"
  | "metadataAvailable"
> {
  return {
    messageSource,
    userMessages: 0,
    userMessagesWithText: 0,
    assistantMessages: 0,
    assistantMessagesWithContent: 0,
    assistantMessagesWithCompletionTime: 0,
    assistantMessagesLinkedToUser: 0,
    invalidMessages: 0,
    danglingReferences: 0,
    sourceCorrupt: false,
  };
}

function convertCapabilityIssue(
  issue: CapabilityProbeIssue,
): SessionRecoveryIssue {
  return {
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    ...(issue.workspaceStorageId
      ? { workspaceStorageId: issue.workspaceStorageId }
      : {}),
  };
}

async function getMessageEvidence(
  context: SessionEvidenceContext,
  provider: SessionEvidenceProvider | undefined,
): Promise<{
  evidence: SessionMessageEvidence &
    Pick<SessionRecoveryEvidence, "messageSource">;
  issue?: SessionRecoveryIssue;
}> {
  if (!provider) {
    return {
      evidence: emptyMessageEvidence("unavailable"),
    };
  }

  try {
    const evidence = await provider(context);
    return {
      evidence: evidence
        ? {
            ...evidence,
            messageSource: "available",
          }
        : emptyMessageEvidence("unavailable"),
    };
  } catch {
    return {
      evidence: emptyMessageEvidence("error"),
      issue: {
        code: "T2O_TRAE_SESSION_EVIDENCE_PROVIDER_FAILED",
        severity: "error",
        message:
          ERROR_DEFINITIONS
            .T2O_TRAE_SESSION_EVIDENCE_PROVIDER_FAILED.message,
        workspaceStorageId: context.workspaceStorageId,
        sourceSessionId: context.sourceSessionId,
      },
    };
  }
}

function createRecoveryCounts(
  sessions: SessionRecoveryAssessment[],
): Record<RecoveryGrade, number> {
  const counts: Record<RecoveryGrade, number> = {
    complete: 0,
    partial: 0,
    "metadata-only": 0,
    unrecoverable: 0,
  };
  for (const session of sessions) {
    counts[session.recovery] += 1;
  }
  return counts;
}

export async function assessTraeSessionRecoverability(
  options: TraeSessionRecoveryOptions,
): Promise<TraeSessionRecoveryReport> {
  const capabilities = await probeTraeCapabilities(options);
  const workspaceResolution = resolveTraeWorkspaces({
    platform: options.root.platform,
    workspaceStoragePath: options.root.workspaceStoragePath,
  });
  const capabilityByWorkspace = new Map(
    capabilities.workspaces.map((workspace) => [
      workspace.workspaceStorageId,
      workspace,
    ]),
  );
  const evidenceItems: SessionRecoveryEvidence[] = [];
  const issues = capabilities.issues.map(convertCapabilityIssue);

  for (const workspace of workspaceResolution.workspaces) {
    const capability = capabilityByWorkspace.get(
      workspace.workspaceStorageId,
    );
    if (!capability) continue;

    const sourcePath = path.join(
      workspace.workspaceStoragePath,
      "state.vscdb",
    );
    if (!safeIsFile(sourcePath)) continue;

    let discovery: ReturnType<typeof readSessionIds>;
    try {
      discovery = await withReadonlySqliteSnapshot(
        sourcePath,
        (snapshot) => readSessionIds(snapshot.databasePath),
        { temporaryRoot: options.temporaryRoot },
      );
    } catch {
      issues.push({
        code: "T2O_TRAE_SESSION_DISCOVERY_FAILED",
        severity: "error",
        message:
          ERROR_DEFINITIONS.T2O_TRAE_SESSION_DISCOVERY_FAILED.message,
        workspaceStorageId: workspace.workspaceStorageId,
      });
      continue;
    }

    if (discovery.invalid) {
      issues.push({
        code: "T2O_TRAE_RECOVERY_EVIDENCE_INVALID",
        severity: "warning",
        message:
          ERROR_DEFINITIONS.T2O_TRAE_RECOVERY_EVIDENCE_INVALID.message,
        workspaceStorageId: workspace.workspaceStorageId,
      });
    }

    for (const sourceSessionId of discovery.sessionIds) {
      const context = {
        workspaceStorageId: workspace.workspaceStorageId,
        sourceSessionId,
      };
      const messageEvidence = await getMessageEvidence(
        context,
        options.sessionEvidenceProvider,
      );
      evidenceItems.push({
        ...context,
        profileVerification: capability.profile.verification,
        metadataAvailable: true,
        ...messageEvidence.evidence,
      });
      if (messageEvidence.issue) issues.push(messageEvidence.issue);
    }
  }

  const sessions = gradeSessionRecoveries(evidenceItems);
  return {
    reportVersion: 1,
    capabilities,
    sessions,
    recoveryCounts: createRecoveryCounts(sessions),
    issues,
  };
}
