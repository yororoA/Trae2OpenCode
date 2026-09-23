export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type RecoveryGrade =
  | "complete"
  | "partial"
  | "metadata-only"
  | "unrecoverable";

export type ProfileVerification =
  | "verified"
  | "unverified"
  | "unsupported";

export interface ParserProfileRef {
  id: string;
  version: number;
}

export interface SourceLocator {
  type:
    | "runtime-field"
    | "database-key"
    | "relative-path"
    | "workspace-state";
  value: string;
}

export interface SourceRef {
  workspaceStorageId: string | null;
  sourceSessionId: string | null;
  locator: SourceLocator;
  parserProfile: ParserProfileRef;
  sha256: string;
}

export interface SourceDescriptor {
  product: {
    name: "trae-cn";
    version: string;
  };
  platform: "darwin" | "win32" | "linux";
  profile: ParserProfileRef & {
    verification: ProfileVerification;
  };
  sourceFingerprint: string;
  collectedAt: string;
}

export interface ProjectIR {
  sourceId: string;
  name?: string;
  path?: string;
  sourceRefs: SourceRef[];
}

export interface EventBaseIR {
  sourceId: string;
  order: number;
  createdAt?: number;
  turnSourceId?: string;
  replyToSourceId?: string;
  sourceRefs: SourceRef[];
}

export interface UserEventIR extends EventBaseIR {
  type: "user";
  text: string;
}

export interface ContentBaseIR {
  createdAt?: number;
  completedAt?: number;
  sourceRefs: SourceRef[];
}

export interface TextContentIR extends ContentBaseIR {
  type: "text";
  text: string;
}

export interface ReasoningContentIR extends ContentBaseIR {
  type: "reasoning";
  text: string;
}

export type ToolStatus =
  | "running"
  | "streaming"
  | "completed"
  | "error"
  | "unknown";

export interface ToolContentIR extends ContentBaseIR {
  type: "tool";
  callId: string;
  name: string;
  input: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  status: ToolStatus;
}

export type AssistantContentIR =
  | TextContentIR
  | ReasoningContentIR
  | ToolContentIR;

export interface AssistantEventIR extends EventBaseIR {
  type: "assistant";
  status: "completed" | "running" | "error" | "unknown";
  completedAt?: number;
  content: AssistantContentIR[];
}

export type EventIR = UserEventIR | AssistantEventIR;

export interface ResourceRef {
  sourceId: string;
  type: "attachment" | "file" | "image" | "long-text" | "unknown";
  availability: "available" | "missing" | "deferred";
  relativePath?: string;
  mimeType?: string;
  sha256?: string;
  sizeBytes?: number;
  sourceRefs: SourceRef[];
}

export interface SessionIR {
  sourceId: string;
  title?: string;
  projectSourceId?: string;
  projectPath?: string;
  parentSourceId?: string;
  createdAt?: number;
  updatedAt?: number;
  recovery: RecoveryGrade;
  events: EventIR[];
  resources: ResourceRef[];
  sourceRefs: SourceRef[];
}

export interface DiagnosticSubject {
  type: "bundle" | "project" | "session" | "event" | "resource";
  sourceId?: string;
}

export interface Diagnostic {
  id: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  subject?: DiagnosticSubject;
  sourceRefs: SourceRef[];
  context?: JsonObject;
}

export interface MigrationBundle {
  schemaVersion: 1;
  createdAt: string;
  source: SourceDescriptor;
  projects: ProjectIR[];
  sessions: SessionIR[];
  diagnostics: Diagnostic[];
}
