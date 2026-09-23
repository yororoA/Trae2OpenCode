import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type MessageContentKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool";

export type SourceEvidenceLevel =
  | "unverified"
  | "path-observed"
  | "schema-observed"
  | "row-sampled"
  | "runtime-readback";

export interface MessageSourceLocation {
  contentKind: MessageContentKind;
  availability: "located" | "not-locally-available" | "unknown";
  sourcePath: string | null;
  fields: string[];
  evidenceLevel: SourceEvidenceLevel;
  notes: string[];
}

export interface AiAgentDatabaseSnapshot {
  relativePath: "ModularData/ai-agent/database.db";
  format: "sqlite" | "opaque";
  sizeBytes: number;
  headerSha256: string;
  sidecars: {
    wal: boolean;
    shm: boolean;
  };
}

export interface MessageSourceProbe {
  profileId: "trae-cn-runtime-v2" | "unknown";
  profileVerification: "verified" | "unsupported";
  productVersion: string | null;
  database: AiAgentDatabaseSnapshot | null;
  runtimeReadPath:
    | {
        serviceMethod: "TraeApi.chat.getMessages";
        endpoint: "lite/get_messages";
        environment: "local";
        evidenceLevel: "runtime-readback";
        evidenceFixture: "trae-cn-3.3.104.structured-runtime.json";
      }
    | null;
  locations: MessageSourceLocation[];
}

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii");
const HEADER_SAMPLE_BYTES = 32;
const MAPPED_PRODUCT_VERSIONS = new Set(["3.3.104"]);

/**
 * M0-3 source map verified from a real TRAE CN 3.3.104 V2 runtime readback.
 * Physical database tables remain opaque and are not a production data source.
 */
const MESSAGE_SOURCE_LOCATIONS: readonly MessageSourceLocation[] = [
  {
    contentKind: "user",
    availability: "located",
    sourcePath: "TraeApi.chat.getMessages#message",
    fields: [
      "message_id",
      "chat_session_id",
      "role",
      "query",
      "content",
      "message_type",
      "message_index",
      "created_at",
      "user_message_context",
    ],
    evidenceLevel: "runtime-readback",
    notes: [
      "Real V2 readback verifies non-empty query and content values.",
      "Assistant reply_to_message_id verifies user/assistant association.",
    ],
  },
  {
    contentKind: "assistant",
    availability: "located",
    sourcePath: "TraeApi.chat.getMessages#message",
    fields: [
      "message_id",
      "chat_session_id",
      "turn_id",
      "reply_to_message_id",
      "role",
      "content",
      "message_type",
      "message_index",
      "status",
      "created_at",
      "chat_start_time",
      "chat_end_time",
    ],
    evidenceLevel: "runtime-readback",
    notes: [
      "Real V2 readback verifies structured assistant envelopes and text.",
      "All sampled assistant messages have turn, reply, start, and end timing.",
    ],
  },
  {
    contentKind: "reasoning",
    availability: "located",
    sourcePath:
      "TraeApi.chat.getMessages#assistant.messages[].plan_item",
    fields: ["id", "thought", "reasoning_content", "timing"],
    evidenceLevel: "runtime-readback",
    notes: [
      "Real V2 readback verifies non-empty thought and reasoning_content values.",
      "Only reasoning persisted by TRAE can be recovered.",
      "Hidden reasoning that was never persisted is not recoverable.",
    ],
  },
  {
    contentKind: "tool",
    availability: "located",
    sourcePath:
      "TraeApi.chat.getMessages#assistant.messages[].plan_item.tool_call_info",
    fields: [
      "id",
      "name",
      "params",
      "result.status",
      "result.data",
      "result.error_message",
      "timing.generated_at_ms",
      "timing.tool_call_started_at_ms",
      "timing.tool_call_finished_at_ms",
    ],
    evidenceLevel: "runtime-readback",
    notes: [
      "Real V2 readback verifies tool names, parameters, results, and status.",
      "Plan-item containment provides the assistant/tool association.",
    ],
  },
];

export function getMessageSourceLocations(): MessageSourceLocation[] {
  return MESSAGE_SOURCE_LOCATIONS.map((location) => ({
    ...location,
    fields: [...location.fields],
    notes: [...location.notes],
  }));
}

function getUnknownMessageSourceLocations(): MessageSourceLocation[] {
  const contentKinds: MessageContentKind[] = [
    "user",
    "assistant",
    "reasoning",
    "tool",
  ];

  return contentKinds.map((contentKind) => ({
    contentKind,
    availability: "unknown",
    sourcePath: null,
    fields: [],
    evidenceLevel: "unverified",
    notes: ["No source mapping has been verified for this product version."],
  }));
}

export function probeAiAgentDatabase(
  userDataPath: string,
): AiAgentDatabaseSnapshot | null {
  const databasePath = path.join(
    path.dirname(userDataPath),
    "ModularData",
    "ai-agent",
    "database.db",
  );
  if (!fs.existsSync(databasePath)) return null;

  const fd = fs.openSync(databasePath, "r");
  const header = Buffer.alloc(HEADER_SAMPLE_BYTES);
  let bytesRead: number;
  try {
    bytesRead = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  const headerSample = header.subarray(0, bytesRead);
  return {
    relativePath: "ModularData/ai-agent/database.db",
    format: headerSample.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)
      ? "sqlite"
      : "opaque",
    sizeBytes: fs.statSync(databasePath).size,
    headerSha256: crypto
      .createHash("sha256")
      .update(headerSample)
      .digest("hex"),
    sidecars: {
      wal: fs.existsSync(`${databasePath}-wal`),
      shm: fs.existsSync(`${databasePath}-shm`),
    },
  };
}

export function probeMessageSources(
  userDataPath: string,
  productVersion: string | null,
): MessageSourceProbe {
  const hasKnownMapping =
    productVersion !== null && MAPPED_PRODUCT_VERSIONS.has(productVersion);

  return {
    profileId: hasKnownMapping ? "trae-cn-runtime-v2" : "unknown",
    profileVerification: hasKnownMapping ? "verified" : "unsupported",
    productVersion,
    database: probeAiAgentDatabase(userDataPath),
    runtimeReadPath: hasKnownMapping
      ? {
          serviceMethod: "TraeApi.chat.getMessages",
          endpoint: "lite/get_messages",
          environment: "local",
          evidenceLevel: "runtime-readback",
          evidenceFixture: "trae-cn-3.3.104.structured-runtime.json",
        }
      : null,
    locations: hasKnownMapping
      ? getMessageSourceLocations()
      : getUnknownMessageSourceLocations(),
  };
}
