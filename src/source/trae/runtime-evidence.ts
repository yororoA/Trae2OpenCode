import * as crypto from "node:crypto";

export const TRAE_RUNTIME_EVIDENCE_PRODUCT_VERSION = "3.3.104";

export interface RuntimeHistoryObservation {
  observedAt: string;
  loadedMessageCount: number;
  storeMessageCount: number;
  pendingMessageCount: number;
  planItemCount: number;
  hasMore: boolean;
}

export interface RuntimeTurnSample {
  assistantMessageHash: string;
  userMessageHash: string;
  turnHash: string;
  messageIndex: number;
  messageType: string;
  status: string;
  relationVerified: boolean;
}

export interface RuntimeToolSample {
  toolCallHash: string;
  statuses: string[];
  terminalStatus: string;
  exitKind: "success" | "error" | "unknown";
}

export interface TraeRuntimeEvidence {
  evidenceVersion: 1;
  sourceProduct: {
    name: "trae-cn";
    version: "3.3.104";
  };
  source: {
    kind: "renderer-runtime-log";
    path: "logs/<run>/window<id>/renderer.log";
    serviceMethod: "_aiAgentChatService.getSessionMessages";
    rpc: "chat/get_messages";
  };
  verification: {
    status: "partial";
    sessionHash: string;
    observedFrom: string;
    observedTo: string;
  };
  history: {
    observations: RuntimeHistoryObservation[];
    paginationObserved: boolean;
    planItemsObserved: boolean;
  };
  turns: {
    samples: RuntimeTurnSample[];
    roleProjectionVerified: boolean;
    replyAssociationVerified: boolean;
    turnAssociationVerified: boolean;
    messageIndicesStrictlyIncreasing: boolean;
  };
  tools: {
    sampledCalls: number;
    pairedCalls: number;
    unpairedCalls: number;
    statusValues: string[];
    samples: RuntimeToolSample[];
  };
  coverage: {
    user: {
      evidenceLevel: "runtime-readback";
      verified: string[];
    };
    assistant: {
      evidenceLevel: "runtime-readback";
      verified: string[];
    };
    reasoning: {
      evidenceLevel: "schema-observed";
      verified: string[];
      unverified: string[];
    };
    tool: {
      evidenceLevel: "runtime-readback";
      verified: string[];
      unverified: string[];
    };
  };
  privacy: {
    messageContentIncluded: false;
    rawIdentifiersIncluded: false;
    absolutePathsIncluded: false;
    accountDataIncluded: false;
  };
  evidenceSha256: string;
}

interface MetadataEvent {
  observedAt: string;
  messageId: string;
  turnId: string;
  replyToMessageId: string;
  messageIndex: number;
  messageType: string;
  status: string;
}

interface AppliedMetadataEvent {
  agentMessageId: string;
  userMessageId: string;
}

interface ToolTransition {
  status: string;
  exitCode?: number;
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function parseTimestamp(line: string): string {
  return line.slice(0, 29);
}

function parseAfterMarker(
  line: string,
  marker: string,
): Record<string, unknown> | null {
  const index = line.indexOf(marker);
  if (index < 0) return null;
  try {
    return JSON.parse(line.slice(index + marker.length)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | null {
  return typeof value[key] === "number" ? value[key] : null;
}

function booleanField(
  value: Record<string, unknown>,
  key: string,
): boolean | null {
  return typeof value[key] === "boolean" ? value[key] : null;
}

function strictlyIncreasing(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}

export function collectTraeRuntimeEvidence(
  log: string,
  sessionId: string,
  productVersion: string,
): TraeRuntimeEvidence {
  if (productVersion !== TRAE_RUNTIME_EVIDENCE_PRODUCT_VERSION) {
    throw new Error(
      `Unsupported TRAE runtime evidence version: ${productVersion}`,
    );
  }

  const histories: RuntimeHistoryObservation[] = [];
  const metadata: MetadataEvent[] = [];
  const appliedMetadata: AppliedMetadataEvent[] = [];
  const tools = new Map<string, ToolTransition[]>();
  const timestamps: string[] = [];

  for (const line of log.split(/\r?\n/)) {
    if (!line.includes(sessionId)) continue;

    const history = parseAfterMarker(
      line,
      "[stream-diagnostics][init] history messages loaded ",
    );
    if (history) {
      const loadedMessageCount = numberField(history, "loadedMessageCount");
      const storeMessageCount = numberField(history, "storeMessageCount");
      const pendingMessageCount = numberField(history, "pendingMessageCount");
      const planItemCount = numberField(history, "planItemCount");
      const hasMore = booleanField(history, "hasMore");
      if (
        loadedMessageCount !== null &&
        storeMessageCount !== null &&
        pendingMessageCount !== null &&
        planItemCount !== null &&
        hasMore !== null
      ) {
        const observedAt = parseTimestamp(line);
        histories.push({
          observedAt,
          loadedMessageCount,
          storeMessageCount,
          pendingMessageCount,
          planItemCount,
          hasMore,
        });
        timestamps.push(observedAt);
      }
      continue;
    }

    const messageMetadata = parseAfterMarker(
      line,
      "[MetadataHandler] received metadata ",
    );
    if (messageMetadata) {
      const messageId = stringField(messageMetadata, "message_id");
      const turnId = stringField(messageMetadata, "turn_id");
      const replyToMessageId = stringField(
        messageMetadata,
        "reply_to_message_id",
      );
      const messageIndex = numberField(messageMetadata, "message_index");
      const messageType = stringField(messageMetadata, "message_type");
      const status = stringField(messageMetadata, "status");
      if (
        messageId &&
        turnId &&
        replyToMessageId &&
        messageIndex !== null &&
        messageType &&
        status
      ) {
        const observedAt = parseTimestamp(line);
        metadata.push({
          observedAt,
          messageId,
          turnId,
          replyToMessageId,
          messageIndex,
          messageType,
          status,
        });
        timestamps.push(observedAt);
      }
      continue;
    }

    const applied = parseAfterMarker(
      line,
      "[stream-diagnostics][metadata] metadata applied ",
    );
    if (applied) {
      const agentMessageId = stringField(applied, "agentMessageId");
      const userMessageId = stringField(applied, "userMessageId");
      if (agentMessageId && userMessageId) {
        appliedMetadata.push({ agentMessageId, userMessageId });
      }
      continue;
    }

    const tool = parseAfterMarker(
      line,
      "[ai-chat/v2][Realtime] event: background_command_status_changed ",
    );
    if (tool) {
      const toolCallId = stringField(tool, "tool_call_id");
      const result =
        tool.result && typeof tool.result === "object"
          ? tool.result as Record<string, unknown>
          : null;
      const status = result ? stringField(result, "status") : null;
      if (toolCallId && status) {
        const transitions = tools.get(toolCallId) ?? [];
        transitions.push({
          status,
          exitCode: result && typeof result.exit_code === "number"
            ? result.exit_code
            : undefined,
        });
        tools.set(toolCallId, transitions);
      }
    }
  }

  if (histories.length === 0) {
    throw new Error("No get_messages runtime readback was found for the session");
  }

  const appliedPairs = new Set(
    appliedMetadata.map(
      (event) => `${event.agentMessageId}:${event.userMessageId}`,
    ),
  );
  const turnSamples = metadata.slice(0, 8).map((event) => ({
    assistantMessageHash: sha256(event.messageId),
    userMessageHash: sha256(event.replyToMessageId),
    turnHash: sha256(event.turnId),
    messageIndex: event.messageIndex,
    messageType: event.messageType,
    status: event.status,
    relationVerified: appliedPairs.has(
      `${event.messageId}:${event.replyToMessageId}`,
    ),
  }));

  const toolSamples: RuntimeToolSample[] = [];
  let pairedCalls = 0;
  for (const [toolCallId, transitions] of tools) {
    const terminal = [...transitions].reverse().find(
      (transition) => transition.status !== "Running",
    );
    if (terminal) pairedCalls += 1;
    if (toolSamples.length < 12) {
      toolSamples.push({
        toolCallHash: sha256(toolCallId),
        statuses: transitions.map((transition) => transition.status),
        terminalStatus: terminal?.status ?? "unpaired",
        exitKind: terminal?.exitCode === undefined
          ? "unknown"
          : terminal.exitCode === 0
            ? "success"
            : "error",
      });
    }
  }
  const statusValues = [
    ...new Set(
      [...tools.values()].flatMap((transitions) =>
        transitions.map((transition) => transition.status)
      ),
    ),
  ].sort();
  const messageIndices = turnSamples.map((sample) => sample.messageIndex);
  const observedFrom = timestamps[0] ?? histories[0].observedAt;
  const observedTo = timestamps.at(-1) ?? histories.at(-1)!.observedAt;

  const reportWithoutDigest = {
    evidenceVersion: 1 as const,
    sourceProduct: {
      name: "trae-cn",
      version: TRAE_RUNTIME_EVIDENCE_PRODUCT_VERSION,
    } as const,
    source: {
      kind: "renderer-runtime-log" as const,
      path: "logs/<run>/window<id>/renderer.log" as const,
      serviceMethod: "_aiAgentChatService.getSessionMessages" as const,
      rpc: "chat/get_messages" as const,
    },
    verification: {
      status: "partial" as const,
      sessionHash: sha256(sessionId),
      observedFrom,
      observedTo,
    },
    history: {
      observations: histories.slice(0, 8),
      paginationObserved: histories.some((history) => history.hasMore),
      planItemsObserved: histories.some((history) => history.planItemCount > 0),
    },
    turns: {
      samples: turnSamples,
      roleProjectionVerified: turnSamples.length > 0,
      replyAssociationVerified:
        turnSamples.length > 0 &&
        turnSamples.every((sample) => sample.relationVerified),
      turnAssociationVerified:
        turnSamples.length > 0 &&
        metadata.slice(0, turnSamples.length).every(
          (event) => event.turnId.length > 0,
        ),
      messageIndicesStrictlyIncreasing: strictlyIncreasing(messageIndices),
    },
    tools: {
      sampledCalls: tools.size,
      pairedCalls,
      unpairedCalls: tools.size - pairedCalls,
      statusValues,
      samples: toolSamples,
    },
    coverage: {
      user: {
        evidenceLevel: "runtime-readback" as const,
        verified: [
          "user message identity in assistant reply relation",
          "session membership",
        ],
      },
      assistant: {
        evidenceLevel: "runtime-readback" as const,
        verified: [
          "assistant message identity",
          "message_index ordering",
          "turn_id and reply_to_message_id association",
        ],
      },
      reasoning: {
        evidenceLevel: "schema-observed" as const,
        verified: ["plan items are attached during history readback"],
        unverified: [
          "thought text projection",
          "reasoning versus non-reasoning plan item classification",
        ],
      },
      tool: {
        evidenceLevel: "runtime-readback" as const,
        verified: [
          "tool_call_id status transition",
          "terminal success/error classification",
        ],
        unverified: [
          "tool_name projection",
          "tool_params payload",
          "tool_result payload",
          "plan_item to tool_call_id database join",
        ],
      },
    },
    privacy: {
      messageContentIncluded: false as const,
      rawIdentifiersIncluded: false as const,
      absolutePathsIncluded: false as const,
      accountDataIncluded: false as const,
    },
  };
  const report: TraeRuntimeEvidence = {
    ...reportWithoutDigest,
    evidenceSha256: sha256(JSON.stringify(reportWithoutDigest)),
  };
  const serialized = JSON.stringify(report);
  const forbiddenValues = [sessionId, "/Users/", "user_id", "parsed_query"];
  if (forbiddenValues.some((value) => serialized.includes(value))) {
    throw new Error("Runtime evidence redaction check failed");
  }
  return report;
}
