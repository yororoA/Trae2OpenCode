import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ERROR_DEFINITIONS } from "../../shared/error-codes.js";
import { verifyOpenCodeRoundtrip } from "../opencode/roundtrip.js";

describe("public OpenCode roundtrip verifier", () => {
  it("uses the shared version rejection code, cleans isolation and writes no success report", async () => {
    await fs.mkdir("tmp", { recursive: true });
    const repository = await fs.mkdtemp(path.resolve("tmp", "roundtrip-rejection-"));
    const output = path.join(repository, "report");
    try {
      // Node is a portable real executable whose version cannot be an OpenCode candidate.
      await assert.rejects(verifyOpenCodeRoundtrip({ repository, output, binary: process.execPath }),
        { code: "T2O_OPENCODE_VERSION_UNSUPPORTED" });
      assert.deepEqual(await fs.readdir(path.join(repository, "tmp")), []);
      await assert.rejects(fs.access(output), { code: "ENOENT" });
    } finally { await fs.rm(repository, { recursive: true, force: true }); }
  });

  it("honors --binary over the test environment and emits a single coded JSON failure", () => {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/verify-opencode-roundtrip.ts",
      "--binary", process.execPath, "--json",
    ], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, T2O_TEST_OPENCODE_BINARY: "missing-private-binary" },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, ERROR_DEFINITIONS.T2O_OPENCODE_VERSION_UNSUPPORTED.exitCode);
    assert.equal(result.stdout, "");
    const lines = result.stderr.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      status: "failed", code: "T2O_OPENCODE_VERSION_UNSUPPORTED",
      message: ERROR_DEFINITIONS.T2O_OPENCODE_VERSION_UNSUPPORTED.message,
    });
    assert.doesNotMatch(result.stderr, /missing-private-binary|t2o-opencode-|Only OpenCode/);
  });

  it("honors the integration binary override with readable default errors", () => {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/verify-opencode-roundtrip.ts",
    ], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, T2O_TEST_OPENCODE_BINARY: process.execPath },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, ERROR_DEFINITIONS.T2O_OPENCODE_VERSION_UNSUPPORTED.exitCode);
    assert.match(result.stderr, /T2O_OPENCODE_VERSION_UNSUPPORTED/);
    assert.doesNotMatch(result.stdout, /验证通过/);
  });

  it("rejects unknown options and missing values before running a binary", () => {
    for (const args of [["--unknown"], ["--output"], ["--binary"]]) {
      const result = spawnSync(process.execPath, [
        "--import", "tsx", "scripts/verify-opencode-roundtrip.ts", ...args,
      ], { encoding: "utf8", timeout: 30_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^Usage:/);
    }
  });
});
