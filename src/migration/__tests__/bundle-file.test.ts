import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { MAX_BUNDLE_BYTES } from "../../shared/limits.js";
import { exportBundleFile, readBundleFile, summarizeBundle } from "../bundle-file.js";
import type { AssistantEventIR, ToolContentIR, UserEventIR } from "../../ir/types.js";

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
      message: "private-message", context: { opaque: "private-value" }, sourceRefs: [] });
    const summary = summarizeBundle(bundle);
    assert.equal(summary.sessions[0].messageCount, 2);
    assert.deepEqual(summary.diagnosticCodes, ["T2O_EXAMPLE"]);
    assert.doesNotMatch(JSON.stringify(summary), /private|persisted|Read this file|中文/);
  });

  it("distinguishes missing and malformed files without exposing paths", async () => {
    await assert.rejects(readBundleFile("/private-missing-bundle"), { code: "T2O_MIGRATION_BUNDLE_NOT_FOUND" });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-invalid-bundle-"));
    try {
      const file = path.join(root, "invalid.json");
      await fs.writeFile(file, "{not-json");
      await assert.rejects(readBundleFile(file), { code: "T2O_MIGRATION_BUNDLE_INVALID_JSON" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
    await assert.rejects(readBundleFile("fixtures/ir/v1/invalid-unknown-field.json"), { code: "T2O_IR_SCHEMA_INVALID" });
  });

  it("rejects a bundle above the 1 GiB input limit before reading it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-large-bundle-"));
    try {
      const file = path.join(root, "large.json");
      const handle = await fs.open(file, "w");
      try { await handle.truncate(MAX_BUNDLE_BYTES + 1); } finally { await handle.close(); }
      await assert.rejects(readBundleFile(file), { code: "T2O_MIGRATION_BUNDLE_TOO_LARGE" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects credentials anywhere in a bundle before export or summary without mutating source data", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-private-export-"));
    try {
      for (const location of ["title", "user", "reasoning", "tool", "diagnostic", "locator", "id"]) {
        const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
        const synthetic = `ghp_${"A".repeat(36)}`;
        const session = bundle.sessions[0];
        if (location === "title") session.title = synthetic;
        if (location === "id") session.sourceId = synthetic;
        if (location === "user") (session.events[0] as UserEventIR).text = synthetic;
        if (location === "reasoning") (session.events[1] as AssistantEventIR).content[0] = {
          type: "reasoning", text: synthetic, sourceRefs: session.sourceRefs,
        };
        if (location === "tool") ((session.events[1] as AssistantEventIR).content[3] as ToolContentIR).output =
          JSON.stringify({ apiKey: "synthetic-tool-key" });
        if (location === "locator") session.sourceRefs[0].locator.value = synthetic;
        if (location === "diagnostic") bundle.diagnostics.push({
          id: "synthetic", severity: "warning", code: "T2O_EXAMPLE", message: "Needs rebinding",
          context: { token: synthetic }, sourceRefs: [],
        });
        const before = JSON.stringify(bundle);
        const expected = { code: "T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING" };
        await assert.rejects(exportBundleFile(bundle, path.join(root, location)), expected);
        assert.throws(() => summarizeBundle(bundle), expected);
        assert.equal(JSON.stringify(bundle), before);
      }
      assert.deepEqual(await fs.readdir(root), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("inspects offline data before schema diagnostics can echo a sensitive object key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-sensitive-input-"));
    try {
      const file = path.join(root, "input.json");
      await fs.writeFile(file, JSON.stringify({ [`ghp_${"A".repeat(36)}`]: {} }));
      await assert.rejects(readBundleFile(file), { code: "T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
