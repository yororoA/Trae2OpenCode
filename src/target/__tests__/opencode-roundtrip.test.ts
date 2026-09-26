import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ERROR_DEFINITIONS } from "../../shared/error-codes.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  verifyOpenCodeRoundtrip,
  verifyOpenCodeRoundtrips,
} from "../opencode/roundtrip.js";

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

  it("isolates evidence for each discovered dialect and writes a summary", async () => {
    const root = await fs.mkdtemp(path.resolve("tmp", "roundtrip-multi-"));
    const calls: Array<{ binary?: string; output: string }> = [];
    try {
      const { report, failures } = await verifyOpenCodeRoundtrips({
        repository: root,
        output: path.join(root, "evidence"),
        targets: [
          { dialect: "v1", version: "1.18.32", binary: "/private/v1" },
          { dialect: "v2", version: "2.0.18", binary: "/private/v2" },
        ],
        verify: async (options) => {
          calls.push({ binary: options.binary, output: options.output });
          const dialect = options.binary?.endsWith("v1") ? "v1" : "v2";
          return {
            reportVersion: 2,
            targetVersion: dialect === "v1" ? "1.18.32" : "2.0.18",
            serverVersion: dialect === "v1" ? "1.18.32" : "2.0.18",
            dialect,
            compatibility: dialect === "v1" ? "verified-release" : "isolated-roundtrip",
            checkedAt: "2026-09-26T00:00:00.000Z",
            status: "verified",
            source: "synthetic-fixture-only",
            fixtureSha256: `sha256:${"a".repeat(64)}`,
            schemaSha256: `sha256:${"b".repeat(64)}`,
            isolation: {
              privateServer: true,
              separateDatabase: true,
              separateHomeAndXdgDirectories: true,
            },
            checks: {
              nativeImportExport: true,
              adapterReadback: true,
              duplicateImportRejected: true,
              duplicateTranscriptUnchanged: true,
              parentChildRoundtrip: true,
              parentDeletionProtected: true,
              changedHashDeletionProtected: true,
              deletionReadback: true,
            },
            limitations: [],
          };
        },
      });
      assert.deepEqual(failures, []);
      assert.equal(report.status, "verified");
      assert.deepEqual(report.targets.map((target) => target.dialect), ["v1", "v2"]);
      assert.deepEqual(calls.map((call) => path.basename(call.output)), ["v1", "v2"]);
      const written = JSON.parse(await fs.readFile(
        path.join(root, "evidence", "report.json"),
        "utf8",
      ));
      assert.deepEqual(written, report);
      assert.doesNotMatch(JSON.stringify(written), /private\/v[12]/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("continues after one dialect fails and records a coded aggregate failure", async () => {
    const root = await fs.mkdtemp(path.resolve("tmp", "roundtrip-multi-failure-"));
    const calls: string[] = [];
    try {
      const { report, failures } = await verifyOpenCodeRoundtrips({
        repository: root,
        output: path.join(root, "evidence"),
        targets: [
          { dialect: "v1", version: "1.18.32", binary: "/private/v1" },
          { dialect: "v2", version: "2.0.18", binary: "/private/v2" },
        ],
        verify: async (options) => {
          calls.push(options.binary!);
          throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
        },
      });
      assert.deepEqual(calls, ["/private/v1", "/private/v2"]);
      assert.equal(report.status, "failed");
      assert.equal(failures.length, 2);
      assert.deepEqual(report.targets.map((target) => target.code), [
        "T2O_OPENCODE_COMPATIBILITY_UNVERIFIED",
        "T2O_OPENCODE_COMPATIBILITY_UNVERIFIED",
      ]);
      assert.doesNotMatch(JSON.stringify(report), /private\/v[12]/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
