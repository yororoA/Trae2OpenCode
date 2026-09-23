import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMigrationTarget } from "../target.js";

describe("migration target", () => {
  it("rejects remote or credential-bearing URLs even with an injected transport", () => {
    const transport = {
      async run() { assert.fail("No process before endpoint validation"); },
      async request() { assert.fail("No request before endpoint validation"); },
    };
    for (const serverUrl of ["https://remote.test", "http://user:secret@localhost:1", "http://localhost:1/path"]) {
      assert.throws(() => createMigrationTarget({ serverUrl, transport }), { code: "T2O_OPENCODE_SERVER_INVALID" });
    }
  });

  it("refuses to describe or write an unverified target version", async () => {
    const target = createMigrationTarget({
      serverUrl: "http://127.0.0.1:1234",
      transport: {
        async run(args) { assert.deepEqual(args, ["--version"]); return "2.0.13"; },
        async request() { assert.fail("No requests for unsupported binary"); },
      },
    });
    await assert.rejects(target.describe(), { code: "T2O_OPENCODE_VERSION_UNSUPPORTED" });
    await assert.rejects(target.readSession("ses_synthetic"), { code: "T2O_OPENCODE_VERSION_UNSUPPORTED" });
  });
});
