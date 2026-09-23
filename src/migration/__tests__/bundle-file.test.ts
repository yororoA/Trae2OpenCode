import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { exportBundleFile, readBundleFile, summarizeBundle } from "../bundle-file.js";

describe("bundle files", () => {
  it("exports a private, complete bundle and refuses an existing directory", async () => {
    const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-export-"));
    const output = path.join(root, "export");
    try {
      const result = await exportBundleFile(bundle, output);
      const file = path.join(output, result.filename);
      assert.deepEqual(await readBundleFile(file), bundle);
      if (process.platform !== "win32") {
        assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(output)).mode & 0o777, 0o700);
      }
      await assert.rejects(exportBundleFile(bundle, output), { code: "T2O_MIGRATION_EXPORT_FAILED" });
      assert.deepEqual(await readBundleFile(file), bundle);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("only includes counts, identities, hashes and fixed codes in summary", async () => {
    const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
    bundle.sessions[0].title = "private-title";
    bundle.sessions[0].projectPath = "/Users/private/project";
    bundle.diagnostics.push({ id: "private-diagnostic", severity: "warning", code: "T2O_EXAMPLE",
      message: "private-message", context: { token: "private-token" }, sourceRefs: [] });
    const summary = summarizeBundle(bundle);
    assert.equal(summary.sessions[0].messageCount, 2);
    assert.deepEqual(summary.diagnosticCodes, ["T2O_EXAMPLE"]);
    assert.doesNotMatch(JSON.stringify(summary), /private|persisted|Read this file|中文/);
  });

  it("rejects malformed files without exposing input or filesystem errors", async () => {
    await assert.rejects(readBundleFile("/private-missing-bundle"), { code: "T2O_MIGRATION_BUNDLE_READ_FAILED" });
    await assert.rejects(readBundleFile("fixtures/ir/v1/invalid-unknown-field.json"), { code: "T2O_IR_SCHEMA_INVALID" });
  });
});
