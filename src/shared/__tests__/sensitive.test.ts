import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertNoCredentials,
  containsCredentials,
  redactCredentialValues,
  redactSensitiveText,
} from "../sensitive.js";

describe("credential inspection boundaries", () => {
  it("detects common credential formats without returning their values", () => {
    const synthetic = "A".repeat(36);
    for (const value of [
      `ghp_${synthetic}`, `github_pat_${synthetic}`, `npm_${synthetic}`, `sk-proj-${synthetic}`,
      `sk-ant-${synthetic}`, `xoxb-${synthetic}`, `glpat-${synthetic}`, `hf_${synthetic}`, `AIza${synthetic}`,
      `AKIA${"A".repeat(16)}`, `eyJ${synthetic}.${synthetic}.${synthetic}`,
      "-----BEGIN RSA PRIVATE KEY-----", "https://user:example-password@example.test",
      `Authorization: Bearer ${synthetic}`, `Basic ${synthetic}`, "Cookie: session=example-session",
      "?X-Amz-Signature=synthetic", "?X-Goog-Signature=synthetic",
    ]) {
      assert.equal(containsCredentials({ nested: ["text", value] }), true);
      assert.throws(() => assertNoCredentials(value), { code: "T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING" });
      assert.equal(redactSensitiveText(value), "[REDACTED_SECRET]");
    }
  });

  it("detects env, header, URL query, config and shell credential assignments", () => {
    for (const key of ["apiKey", "APIKey", "api_key", "SECRET_KEY", "AWS_SECRET_ACCESS_KEY",
      "clientSecret", "refresh_token", "password", "OPENCODE_SERVER_PASSWORD", "authorization", "Cookie"]) {
      assert.equal(containsCredentials({ [key]: "synthetic" }), true, key);
      assert.equal(containsCredentials(`${key}=synthetic`), true, key);
      assert.equal(containsCredentials(`config.${key} = 'synthetic'`), true, key);
    }
    for (const text of ["curl --password synthetic", "curl --api-key=synthetic",
      "curl --access-token 'synthetic'", "https://example.test/?token=synthetic",
      "password: 'short value'", 'api_key: "short value"']) {
      assert.equal(containsCredentials(text), true);
    }
  });

  it("inspects encoded tool JSON, percent-encoded URLs, and keys containing tokens", () => {
    const encoded = JSON.stringify(JSON.stringify({ password: "synthetic" }));
    const escaped = '{"pass\\u0077ord":"synthetic"}';
    assert.equal(containsCredentials({ output: encoded }), true);
    assert.equal(containsCredentials(escaped), true);
    assert.equal(containsCredentials("https://example.test/?%74oken=synthetic"), true);
    assert.equal(containsCredentials({ [`ghp_${"A".repeat(36)}`]: "safe-value" }), true);
  });

  it("keeps ordinary prose, hashes and explicit unbound references unchanged", () => {
    const safe = {
      text: "Read this file. 中文\nThe token count is 200. A password is required.",
      status: "completed", tokens: 200, tokenCount: 200,
      hash: `sha256:${"a".repeat(64)}`,
      apiKey: `\${API_KEY}`, password: "[REDACTED]", secretKey: "needs-rebinding",
      headers: { Authorization: null }, credential: "", output: "Invalid JSON {",
      reference: `password = \${LOCAL_PASSWORD}`, url: "https://example.test/?q=hello%20world",
    };
    const before = structuredClone(safe);
    assert.equal(containsCredentials(safe), false);
    assert.doesNotThrow(() => assertNoCredentials(safe));
    assert.deepEqual(safe, before);
    assert.equal(redactSensitiveText(safe.text), safe.text);
  });

  it("redacts recognized values without retaining secrets or mutating input", () => {
    const secret = `ghp_${"A".repeat(36)}`;
    const input = {
      prose: `Use ${secret} only for this command.`,
      nested: {
        password: "synthetic-password",
        encoded: JSON.stringify({ authorization: `Bearer ${"B".repeat(24)}` }),
      },
      safe: "Keep this text.",
    };
    const before = structuredClone(input);

    const result = redactCredentialValues(input);

    assert.deepEqual(input, before);
    assert.ok(result.redactedCount >= 3);
    assert.equal(result.value.safe, input.safe);
    assert.match(result.value.prose, /Use \[REDACTED_SECRET\] only/);
    assert.equal(result.value.nested.password, "[REDACTED_SECRET]");
    assert.doesNotThrow(() => assertNoCredentials(result.value));
    assert.doesNotMatch(JSON.stringify(result.value), new RegExp(secret));
  });

  it("redacts credential-bearing dynamic keys and fails closed for CLI secrets", () => {
    const secret = `ghp_${"A".repeat(36)}`;
    const keyed = redactCredentialValues({
      [secret]: "value",
      "[REDACTED_KEY_1]": "existing",
    });
    assert.deepEqual(keyed.value, {
      "[REDACTED_KEY_2]": "value",
      "[REDACTED_KEY_1]": "existing",
    });
    assert.equal(
      redactCredentialValues("curl --token synthetic https://example.test").value,
      "[REDACTED_SECRET]",
    );
  });

  it("fails closed on unsupported nesting and safely handles shared or cyclic objects", () => {
    const cyclic: Record<string, unknown> = { text: "safe" };
    cyclic.self = cyclic;
    assert.equal(containsCredentials(cyclic), false);
    let nested: unknown = "safe";
    for (let depth = 0; depth < 258; depth++) nested = { nested };
    assert.throws(() => assertNoCredentials(nested), { code: "T2O_SENSITIVE_SCAN_LIMIT" });
    assert.equal(redactSensitiveText(JSON.stringify(nested)), "[REDACTED_SECRET]");
  });
});
