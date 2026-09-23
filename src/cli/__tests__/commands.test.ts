import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { executeReadCommand, loadCommandBundle } from "../commands.js";

const input = "fixtures/ir/v1/valid-trae-assembled.json";

describe("read commands", () => {
  it("plans dry-run from offline IR and rejects flags on unrelated commands", async () => {
    const report = await executeReadCommand("migrate", {
      input, dryRun: true, fallbackDirectory: process.cwd(),
    }) as { ready: number; dryRun: boolean; target: unknown };
    assert.equal(report.ready, 1);
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.target, { probed: false });
    assert.doesNotMatch(JSON.stringify(report), /Read this file|First persisted/);
    await assert.rejects(executeReadCommand("scan", { input, dryRun: true }),
      { code: "T2O_CLI_INVALID_ARGUMENTS" });
    await assert.rejects(executeReadCommand("migrate", { input, dryRun: true, output: "unused" }),
      { code: "T2O_CLI_INVALID_ARGUMENTS" });
  });

  it("scans and previews offline bundles without requiring a target", async () => {
    for (const command of ["scan", "preview"]) {
      const result = await executeReadCommand(command, { input }) as { sessions: unknown[] };
      assert.equal(result.sessions.length, 1);
      assert.doesNotMatch(JSON.stringify(result), /First persisted|synthetic\/project/);
    }
  });

  it("validates source selection and output arguments before reading or writing", async () => {
    await assert.rejects(loadCommandBundle({ input, cdp: "http://127.0.0.1:1" }), { code: "T2O_CLI_INVALID_ARGUMENTS" });
    await assert.rejects(loadCommandBundle({ cdpTarget: "missing" }), { code: "T2O_CLI_INVALID_ARGUMENTS" });
    await assert.rejects(executeReadCommand("export", { input }), { code: "T2O_CLI_INVALID_ARGUMENTS" });
  });

  it("exports offline IR and reports unavailable doctor prerequisites", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-command-"));
    try {
      const result = await executeReadCommand("export", { input, output: path.join(root, "output") });
      assert.match(JSON.stringify(result), /migration-bundle.json/);
      const doctor = await executeReadCommand("doctor", { traeRoot: path.join(root, "absent") });
      assert.match(JSON.stringify(doctor), /T2O_TRAE_ROOT_NOT_FOUND|T2O_TRAE_PLATFORM_UNSUPPORTED/);
      assert.doesNotMatch(JSON.stringify(doctor), new RegExp(root));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects replacement flag misuse before opening source or target", async () => {
    await assert.rejects(executeReadCommand("scan", { replace: "old.json" }), { code: "T2O_CLI_INVALID_ARGUMENTS" });
    await assert.rejects(executeReadCommand("migrate", { dryRun: true, replace: "old.json" }),
      { code: "T2O_CLI_INVALID_ARGUMENTS" });
    await assert.rejects(executeReadCommand("migrate", { server: "invalid", resume: "resume.json", replace: "old.json" }),
      { code: "T2O_CLI_INVALID_ARGUMENTS" });
    await assert.rejects(executeReadCommand("migrate", { server: "invalid", output: "new", replace: "old.json" }),
      { code: "T2O_MIGRATION_EXCLUSIVE_REQUIRED" });
  });

  it("validates rollback and confirmation arguments before opening source or target", async () => {
    for (const command of ["scan", "verify", "migrate"]) {
      await assert.rejects(executeReadCommand(command, { confirm: "run" }), { code: "T2O_CLI_INVALID_ARGUMENTS" });
    }
    for (const options of [{}, { manifest: "run.json" }, { server: "invalid" },
      { server: "invalid", manifest: "run.json", input }, { server: "invalid", manifest: "run.json", dryRun: true }]) {
      await assert.rejects(executeReadCommand("rollback", options), { code: "T2O_CLI_INVALID_ARGUMENTS" });
    }
    await assert.rejects(executeReadCommand("rollback", { server: "invalid", manifest: "run.json", confirm: "run" }),
      { code: "T2O_MIGRATION_EXCLUSIVE_REQUIRED" });
  });
});
