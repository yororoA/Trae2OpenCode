import { parseTree, type ParseError } from "jsonc-parser";
import { Trae2OpenCodeError } from "./errors.js";

const CREDENTIAL_KEY = /(?:^|[_.-])(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret(?:[_-]?(?:access[_-]?)?key)?|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|private[_-]?key|authorization|cookie|set[_-]?cookie|credentials?)$/i;
const KNOWN_CREDENTIALS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9]{20,})\b/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/,
  /\b(?:glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,})\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{8,}/i,
  /[?&](?:X-Amz-Signature|X-Goog-Signature|sig)=[^&\s"'<>]+/i,
];
const ASSIGNMENT = /(?:^|[\s"'?&,{])([A-Za-z_][A-Za-z0-9_.-]{0,127})["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|(\$\{[A-Z_][A-Z0-9_]*\}|[^\s,;&}\]]+))/g;
const CLI_SECRET = /--(?:[a-z]+-)*(?:api-key|token|password|secret|client-secret|access-key)(?:\s+|=)(?:"[^"]+"|'[^']+'|[^\s;]+)/i;
const REFERENCE = /^(?:\[REDACTED(?:_SECRET)?\]|<redacted>|needs-rebinding|\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*|process\.env\.[A-Z_][A-Z0-9_]*)$/i;
const REDACTED_SECRET = "[REDACTED_SECRET]";
const DIRECT_CREDENTIAL_REDACTIONS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9]{20,})\b/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g,
  /\b(?:glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,})\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\b/g,
];
const CREDENTIAL_URL_REDACTION = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const AUTHORIZATION_REDACTION = /\b((?:Bearer|Basic)\s+)[A-Za-z0-9+/_.=-]{8,}/gi;
const SIGNATURE_REDACTION = /([?&](?:X-Amz-Signature|X-Goog-Signature|sig)=)[^&\s"'<>]+/gi;
const ASSIGNMENT_REDACTION =
  /(^|[\s"'?&,{])([A-Za-z_][A-Za-z0-9_.-]{0,127})(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(\$\{[A-Z_][A-Z0-9_]*\}|[^\s,;&}\]]+))/gm;

function credentialKey(key: string): boolean {
  const normalized = key.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return CREDENTIAL_KEY.test(normalized);
}

function populated(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "string") return !REFERENCE.test(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Recognized credential patterns only; arbitrary prose and encrypted values are not identifiable. */
export function containsCredentialText(text: string): boolean {
  if (KNOWN_CREDENTIALS.some((pattern) => pattern.test(text))) return true;
  if (CLI_SECRET.test(text)) return true;
  const assignments = new RegExp(ASSIGNMENT);
  for (let match = assignments.exec(text); match; match = assignments.exec(text)) {
    const value = match[2] ?? match[3] ?? match[4];
    if (credentialKey(match[1]) && populated(value)) return true;
    // Non-sensitive prefixes (e.g. https:) must not consume a later ?token= assignment.
    assignments.lastIndex = match.index + match[0].indexOf(match[1]) + match[1].length;
  }
  return false;
}

/** Iterative and bounded, including JSON encoded inside tool output strings and dynamic keys. */
export function containsCredentials(value: unknown): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let visited = 0;
  const inspectJson = (text: string, depth: number): boolean | undefined => {
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
    if (!root || errors.length > 0) return undefined;
    const nodes = [{ node: root, depth }];
    while (nodes.length > 0) {
      const item = nodes.pop()!;
      if (++visited > 2_000_000 || item.depth > 256) {
        throw new Trae2OpenCodeError("T2O_SENSITIVE_SCAN_LIMIT");
      }
      if (item.node.type === "property") {
        const [keyNode, valueNode] = item.node.children ?? [];
        const key = keyNode?.value;
        if (typeof key !== "string" || !valueNode) {
          throw new Trae2OpenCodeError("T2O_SENSITIVE_SCAN_LIMIT");
        }
        const valueIsPopulated = valueNode.type === "string"
          ? populated(valueNode.value)
          : valueNode.type === "object" || valueNode.type === "array"
            ? (valueNode.children?.length ?? 0) > 0
            : valueNode.type !== "null";
        if (containsCredentialText(key) || (credentialKey(key) && valueIsPopulated)) return true;
        nodes.push({ node: valueNode, depth: item.depth + 1 });
        continue;
      }
      if (item.node.type === "string") {
        pending.push({ value: item.node.value, depth: item.depth + 1 });
        continue;
      }
      for (const child of item.node.children ?? []) {
        nodes.push({ node: child, depth: item.depth + 1 });
      }
    }
    return false;
  };
  while (pending.length) {
    const item = pending.pop()!;
    if (++visited > 2_000_000 || item.depth > 256) {
      throw new Trae2OpenCodeError("T2O_SENSITIVE_SCAN_LIMIT");
    }
    if (typeof item.value === "string") {
      const trimmed = item.value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
        const jsonResult = inspectJson(trimmed, item.depth + 1);
        if (jsonResult !== undefined) {
          if (jsonResult) return true;
          continue;
        }
      }
      if (containsCredentialText(item.value)) return true;
      if (/%[a-f0-9]{2}/i.test(item.value)) {
        try { pending.push({ value: decodeURIComponent(item.value), depth: item.depth + 1 }); }
        catch { /* Malformed URL encoding is inspected as literal text. */ }
      }
      continue;
    }
    if (!item.value || typeof item.value !== "object" || seen.has(item.value)) continue;
    seen.add(item.value);
    for (const [key, child] of Object.entries(item.value)) {
      if (containsCredentialText(key) || (credentialKey(key) && populated(child))) return true;
      pending.push({ value: child, depth: item.depth + 1 });
      if (pending.length > 2_000_000) throw new Trae2OpenCodeError("T2O_SENSITIVE_SCAN_LIMIT");
    }
  }
  return false;
}

export function assertNoCredentials(value: unknown): void {
  if (containsCredentials(value)) throw new Trae2OpenCodeError("T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING");
}

export interface CredentialRedaction<T> {
  value: T;
  redactedCount: number;
}

function redactCredentialText(text: string): CredentialRedaction<string> {
  if (!containsCredentials(text)) return { value: text, redactedCount: 0 };
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
    try {
      const parsed = redactCredentialValues(JSON.parse(trimmed));
      const serialized = JSON.stringify(parsed.value);
      if (!containsCredentials(serialized)) {
        return { value: serialized, redactedCount: parsed.redactedCount };
      }
    } catch {
      // Continue with textual redaction.
    }
  }
  if (/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/.test(text) || CLI_SECRET.test(text)) {
    return { value: REDACTED_SECRET, redactedCount: 1 };
  }
  let value = text;
  let redactedCount = 0;
  for (const pattern of DIRECT_CREDENTIAL_REDACTIONS) {
    value = value.replace(pattern, () => {
      redactedCount += 1;
      return REDACTED_SECRET;
    });
  }
  for (const pattern of [CREDENTIAL_URL_REDACTION, AUTHORIZATION_REDACTION, SIGNATURE_REDACTION]) {
    value = value.replace(pattern, (_match, prefix: string) => {
      redactedCount += 1;
      return `${prefix}${REDACTED_SECRET}`;
    });
  }
  value = value.replace(
    ASSIGNMENT_REDACTION,
    (match, prefix: string, key: string, separator: string, reference?: string) => {
      if (!credentialKey(key) || (reference !== undefined && REFERENCE.test(reference))) return match;
      redactedCount += 1;
      return `${prefix}${key}${separator}"${REDACTED_SECRET}"`;
    },
  );
  if (redactedCount === 0 || containsCredentials(value)) {
    return { value: REDACTED_SECRET, redactedCount: Math.max(redactedCount, 1) };
  }
  return { value, redactedCount };
}

/** Deep-copy JSON-compatible content while replacing only recognized credential-bearing values. */
export function redactCredentialValues<T>(input: T): CredentialRedaction<T> {
  let visited = 0;
  const redact = (value: unknown, depth: number): CredentialRedaction<unknown> => {
    if (++visited > 2_000_000 || depth > 256) {
      throw new Trae2OpenCodeError("T2O_SENSITIVE_SCAN_LIMIT");
    }
    if (typeof value === "string") return redactCredentialText(value);
    if (value === null || typeof value !== "object") return { value, redactedCount: 0 };
    if (Array.isArray(value)) {
      let redactedCount = 0;
      const result = value.map((item) => {
        const redacted = redact(item, depth + 1);
        redactedCount += redacted.redactedCount;
        return redacted.value;
      });
      return { value: result, redactedCount };
    }
    let redactedCount = 0;
    let redactedKeyIndex = 0;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      let outputKey = key;
      if (containsCredentialText(key)) {
        do {
          outputKey = `[REDACTED_KEY_${++redactedKeyIndex}]`;
        } while (Object.hasOwn(value, outputKey) || Object.hasOwn(result, outputKey));
        redactedCount += 1;
      }
      if (credentialKey(key) && populated(child)) {
        result[outputKey] = REDACTED_SECRET;
        redactedCount += 1;
        continue;
      }
      const redacted = redact(child, depth + 1);
      result[outputKey] = redacted.value;
      redactedCount += redacted.redactedCount;
    }
    return { value: result, redactedCount };
  };
  const result = redact(input, 0) as CredentialRedaction<T>;
  assertNoCredentials(result.value);
  return result;
}

/** Fail closed for log fields without echoing an exception or offending value. */
export function redactSensitiveText(value: string): string {
  try { return containsCredentials(value) ? "[REDACTED_SECRET]" : value; }
  catch { return "[REDACTED_SECRET]"; }
}
