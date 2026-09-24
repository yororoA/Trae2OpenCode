import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertMigrationBundle } from "../../ir/validation.js";
import { assertNoCredentials, containsCredentials } from "../../shared/sensitive.js";
import { readBundleFile } from "../bundle-file.js";
import { buildMigrationPlan } from "../plan.js";
import {
  REDACTED_CREDENTIAL_DIAGNOSTIC,
  redactMigrationBundleCredentials,
} from "../redact-credentials.js";

describe("migration bundle credential redaction", () => {
  it("redacts content fields, marks recovery partial, and remains importable", async () => {
    const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
    const secret = `ghp_${"A".repeat(36)}`;
    const session = bundle.sessions[0];
    session.title = `password = "synthetic-password"`;
    const user = session.events.find((event) => event.type === "user");
    assert.ok(user?.type === "user");
    user.text = `Use ${secret} for this example.`;
    const assistant = session.events.find((event) => event.type === "assistant");
    assert.ok(assistant?.type === "assistant");
    const tool = assistant.content.find((block) => block.type === "tool");
    assert.ok(tool?.type === "tool");
    tool.input = { token: "synthetic-token", safe: "retained" };

    const before = structuredClone(bundle);
    assert.equal(containsCredentials(bundle), true);
    const result = redactMigrationBundleCredentials(bundle);

    assert.equal(result.redactedSessionIds.length, 1);
    assert.ok(result.redactedCount >= 3);
    assert.equal(result.bundle.sessions[0].recovery, "partial");
    assert.ok(result.bundle.diagnostics.some((item) =>
      item.code === REDACTED_CREDENTIAL_DIAGNOSTIC &&
      item.subject?.sourceId === session.sourceId));
    assert.doesNotThrow(() => assertMigrationBundle(result.bundle));
    assert.doesNotThrow(() => assertNoCredentials(result.bundle));
    assert.equal(containsCredentials(bundle), true);
    assert.deepEqual(bundle, before);
    const plan = await buildMigrationPlan(result.bundle, {
      fallbackDirectory: process.cwd(),
    });
    assert.equal(plan.sessions[0].status, "ready");
  });

  it("refuses credentials in immutable identity and provenance fields", async () => {
    const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
    bundle.sessions[0].sourceId = `ghp_${"A".repeat(36)}`;

    assert.throws(
      () => redactMigrationBundleCredentials(bundle),
      { code: "T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING" },
    );
  });
});
