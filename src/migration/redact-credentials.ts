import { hashCanonicalJson } from "../ir/canonical.js";
import type { JsonValue, MigrationBundle } from "../ir/types.js";
import { assertMigrationBundle } from "../ir/validation.js";
import { assertNoCredentials, redactCredentialValues } from "../shared/sensitive.js";

export const REDACTED_CREDENTIAL_DIAGNOSTIC = "T2O_SENSITIVE_CONTENT_REDACTED";

export interface RedactedMigrationBundle {
  bundle: MigrationBundle;
  redactedCount: number;
  redactedSessionIds: string[];
}

/** Redact content fields only; identifiers, paths, and provenance remain immutable. */
export function redactMigrationBundleCredentials(
  input: MigrationBundle,
): RedactedMigrationBundle {
  const bundle = structuredClone(assertMigrationBundle(input));
  const redactedSessionIds: string[] = [];
  let redactedCount = 0;

  for (const session of bundle.sessions) {
    let sessionRedactedCount = 0;
    const redact = <T>(value: T): T => {
      const result = redactCredentialValues(value);
      sessionRedactedCount += result.redactedCount;
      return result.value;
    };

    if (session.title !== undefined) session.title = redact(session.title);
    for (const event of session.events) {
      if (event.type === "user") {
        event.text = redact(event.text);
        continue;
      }
      for (const block of event.content) {
        if (block.type === "text" || block.type === "reasoning") {
          block.text = redact(block.text);
          continue;
        }
        block.input = redact(block.input);
        if (block.output !== undefined) block.output = redact(block.output);
        if (block.error !== undefined) block.error = redact(block.error);
      }
    }

    if (sessionRedactedCount === 0) continue;
    redactedCount += sessionRedactedCount;
    redactedSessionIds.push(session.sourceId);
    if (session.recovery === "complete") session.recovery = "partial";
    const diagnostic = {
      code: REDACTED_CREDENTIAL_DIAGNOSTIC,
      message: "Credential-like values were replaced with explicit placeholders before export.",
      severity: "warning" as const,
      subject: { type: "session" as const, sourceId: session.sourceId },
      sourceRefs: [],
      context: { redactedFields: sessionRedactedCount },
    };
    bundle.diagnostics.push({
      id: hashCanonicalJson(diagnostic as unknown as JsonValue),
      ...diagnostic,
    });
  }

  assertNoCredentials(bundle);
  return {
    bundle: assertMigrationBundle(bundle),
    redactedCount,
    redactedSessionIds,
  };
}
