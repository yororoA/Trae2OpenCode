export {
  canonicalizeJson,
  canonicalizeMigrationBundle,
  hashCanonicalJson,
  hashMigrationBundle,
  parseCanonicalMigrationBundle,
} from "./canonical.js";
export { migrationBundleSchema } from "./schema.js";
export {
  assertMigrationBundle,
  validateMigrationBundle,
  type IrValidationIssue,
  type IrValidationResult,
} from "./validation.js";
export type {
  AssistantContentIR,
  AssistantEventIR,
  Diagnostic,
  DiagnosticSubject,
  EventIR,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MigrationBundle,
  ParserProfileRef,
  ProfileVerification,
  ProjectIR,
  ReasoningContentIR,
  RecoveryGrade,
  ResourceRef,
  SessionIR,
  SourceDescriptor,
  SourceLocator,
  SourceRef,
  TextContentIR,
  ToolContentIR,
  ToolStatus,
  UserEventIR,
} from "./types.js";
