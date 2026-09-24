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
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let visited = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++visited > 2_000_000 || item.depth > 256) {
      throw new Trae2OpenCodeError("T2O_SENSITIVE_SCAN_LIMIT");
    }
    if (typeof item.value === "string") {
      if (containsCredentialText(item.value)) return true;
      if (/%[a-f0-9]{2}/i.test(item.value)) {
        try { pending.push({ value: decodeURIComponent(item.value), depth: item.depth + 1 }); }
        catch { /* Malformed URL encoding is inspected as literal text. */ }
      }
      const trimmed = item.value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
        try { pending.push({ value: JSON.parse(trimmed), depth: item.depth + 1 }); }
        catch { /* Non-JSON text still passed the textual scan above. */ }
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

/** Fail closed for log fields without echoing an exception or offending value. */
export function redactSensitiveText(value: string): string {
  try { return containsCredentials(value) ? "[REDACTED_SECRET]" : value; }
  catch { return "[REDACTED_SECRET]"; }
}
