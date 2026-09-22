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
  profileId: "trae-cn-ai-agent-v1" | "unknown";
  profileVerification: "unverified" | "unsupported";
  productVersion: string | null;
  database: AiAgentDatabaseSnapshot | null;
  runtimeReadPath:
    | {
        serviceMethod: "_aiAgentChatService.getSessionMessages";
        endpoint: "lite/get_messages";
        evidenceLevel: "schema-observed";
      }
    | null;
  locations: MessageSourceLocation[];
}

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii");
const HEADER_SAMPLE_BYTES = 32;
const MAPPED_PRODUCT_VERSIONS = new Set(["3.3.104"]);

/**
 * M0-3 source map derived from the TRAE CN 3.3.104 client and ai-agent
 * executable schemas. It deliberately remains below row-sampled until a
 * redacted runtime readback verifies the relationship on real data.
 */
const MESSAGE_SOURCE_LOCATIONS: readonly MessageSourceLocation[] = [
  {
    contentKind: "user",
    availability: "located",
    sourcePath: "ModularData/ai-agent/database.db#chat_message",
    fields: [
      "message_id",
      "session_id",
      "turn_id",
      "content",
      "message_role",
      "message_type",
      "message_index",
      "user_message_context",
    ],
    evidenceLevel: "schema-observed",
    notes: ["Select rows by message_role; role values are not yet row-sampled."],
  },
  {
    contentKind: "assistant",
    availability: "located",
    sourcePath: "ModularData/ai-agent/database.db#chat_message",
    fields: [
      "message_id",
      "session_id",
      "turn_id",
      "content",
      "message_role",
      "message_type",
      "message_index",
    ],
    evidenceLevel: "schema-observed",
    notes: ["Select rows by message_role; role values are not yet row-sampled."],
  },
  {
    contentKind: "reasoning",
    availability: "located",
    sourcePath: "ModularData/ai-agent/database.db#plan_item",
    fields: ["turn_id", "thought"],
    evidenceLevel: "schema-observed",
    notes: [
      "The persisted thought field is a candidate reasoning source.",
      "Hidden reasoning that was never persisted is not recoverable.",
    ],
  },
  {
    contentKind: "tool",
    availability: "located",
    sourcePath: "ModularData/ai-agent/database.db#plan_item",
    fields: [
      "turn_id",
      "tool_id",
      "tool_name",
      "tool_params",
      "tool_result",
      "tool_status",
    ],
    evidenceLevel: "schema-observed",
    notes: ["Call/result pairing and status values are not yet row-sampled."],
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
    profileId: hasKnownMapping ? "trae-cn-ai-agent-v1" : "unknown",
    profileVerification: hasKnownMapping ? "unverified" : "unsupported",
    productVersion,
    database: probeAiAgentDatabase(userDataPath),
    runtimeReadPath: hasKnownMapping
      ? {
          serviceMethod: "_aiAgentChatService.getSessionMessages",
          endpoint: "lite/get_messages",
          evidenceLevel: "schema-observed",
        }
      : null,
    locations: hasKnownMapping
      ? getMessageSourceLocations()
      : getUnknownMessageSourceLocations(),
  };
}
