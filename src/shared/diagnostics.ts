import type {
  Diagnostic,
  DiagnosticSubject,
  JsonObject,
  SourceRef,
} from "../ir/types.js";

export interface DiagnosticInput {
  id: string;
  severity: Diagnostic["severity"];
  code: string;
  message: string;
  subject?: DiagnosticSubject;
  sourceRefs?: SourceRef[];
  context?: JsonObject;
}

export function createDiagnostic(input: DiagnosticInput): Diagnostic {
  return {
    id: input.id,
    severity: input.severity,
    code: input.code,
    message: input.message,
    ...(input.subject ? { subject: input.subject } : {}),
    sourceRefs: input.sourceRefs ?? [],
    ...(input.context ? { context: input.context } : {}),
  };
}

export function getDiagnosticLocation(
  diagnostic: Diagnostic,
): string | undefined {
  const instancePath = diagnostic.context?.instancePath;
  if (typeof instancePath === "string") {
    return instancePath || "/";
  }

  if (diagnostic.subject?.sourceId) {
    return `${diagnostic.subject.type}:${diagnostic.subject.sourceId}`;
  }

  return diagnostic.subject?.type;
}
