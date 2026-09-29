import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMigrationTarget, migrationTargetDescriptorsMatch, type MigrationTargetDescriptor,
} from "../target.js";

describe("migration target", () => {
  it("matches pre-profile descriptors only when their core target evidence is unchanged", () => {
    const core = {
      endpointHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      binaryVersion: "2.0.12",
      serverVersion: "2.0.12",
      schemaHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      fingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    } satisfies MigrationTargetDescriptor;
    const current = {
      ...core,
      protocolRule: "v2-session-transfer" as const,
      protocolHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      fingerprint: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    };
    assert.equal(migrationTargetDescriptorsMatch(core, current), true);
    assert.equal(migrationTargetDescriptorsMatch(
      core, { ...current, schemaHash: current.protocolHash },
    ), false);
    assert.equal(migrationTargetDescriptorsMatch(
      current, { ...current, protocolRule: "v2-session-transfer-legacy" },
    ), false);
  });

  it("rejects remote or credential-bearing URLs even with an injected transport", () => {
    const transport = {
      async run() { assert.fail("No process before endpoint validation"); },
      async request() { assert.fail("No request before endpoint validation"); },
    };
    for (const serverUrl of ["https://remote.test", "http://user:secret@localhost:1", "http://localhost:1/path"]) {
      assert.throws(() => createMigrationTarget({ serverUrl, transport }), { code: "T2O_OPENCODE_SERVER_INVALID" });
    }
  });

  it("refuses to describe or read a target outside the implemented protocol families", async () => {
    const target = createMigrationTarget({
      serverUrl: "http://127.0.0.1:1234",
      transport: {
        async run(args) { assert.deepEqual(args, ["--version"]); return "3.0.0"; },
        async request() { assert.fail("No requests for unsupported binary"); },
      },
    });
    await assert.rejects(target.describe(), { code: "T2O_OPENCODE_VERSION_UNSUPPORTED" });
    await assert.rejects(target.readSession("ses_synthetic"), { code: "T2O_OPENCODE_VERSION_UNSUPPORTED" });
  });
});
