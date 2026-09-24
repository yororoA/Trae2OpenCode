import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type CliIO, runCli } from "../app.js";

function captureIO(): {
  io: CliIO;
  stdout(): string;
  stderr(): string;
} {
  let standardOutput = "";
  let standardError = "";

  return {
    io: {
      stdout(message) {
        standardOutput += message;
      },
      stderr(message) {
        standardError += message;
      },
    },
    stdout: () => standardOutput,
    stderr: () => standardError,
  };
}

describe("runCli", () => {
  it("contains credential failures in both human and JSON output without creating exports", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-sensitive-cli-"));
    try {
      const input = path.join(root, "input.json");
      const synthetic = `ghp_${"A".repeat(36)}`;
      await fs.writeFile(input, JSON.stringify({ [synthetic]: true }));
      for (const json of [false, true]) {
        const output = captureIO();
        const args = ["export", "--input", input, "--output", path.join(root, "export")];
        if (json) args.push("--json");
        assert.equal(await runCli(args, output.io, "9.8.7"), 4);
        assert.equal(output.stdout(), "");
        assert.match(output.stderr(), /T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING/);
        assert.ok(!output.stderr().includes(synthetic));
        assert.ok(!output.stderr().includes(root));
      }
      assert.deepEqual(await fs.readdir(root), ["input.json"]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("accepts dry-run flags and repeated project maps", async () => {
    const output = captureIO();
    assert.equal(await runCli([
      "migrate", "--dry-run", "--input", "fixtures/ir/v1/valid-trae-assembled.json",
      "--fallback-directory", process.cwd(), "--recovery", "complete,partial",
      "--path-map", `/synthetic=${process.cwd()}`, "--path-map", `/elsewhere=${process.cwd()}`,
      "--namespace", "test-cli", "--json",
    ], output.io, "9.8.7"), 0);
    const result = JSON.parse(output.stdout());
    assert.equal(result.ready, 1);
    assert.equal(result.dryRun, true);
    assert.equal(output.stderr(), "");
    assert.ok(!output.stdout().includes(process.cwd()));
  });

  it("prints help when no command is provided", async () => {
    const output = captureIO();

    const exitCode = await runCli([], output.io, "9.8.7");

    assert.equal(exitCode, 0);
    assert.match(output.stdout(), /Trae2OpenCode 9\.8\.7/);
    assert.match(output.stdout(), /trae2opencode <command>/);
    assert.equal(output.stderr(), "");
  });

  it("prints the package version", async () => {
    const output = captureIO();

    const exitCode = await runCli(["--version"], output.io, "9.8.7");

    assert.equal(exitCode, 0);
    assert.equal(output.stdout(), "9.8.7\n");
    assert.equal(output.stderr(), "");
  });

  it("rejects unknown options without exposing a stack trace", async () => {
    const output = captureIO();

    const exitCode = await runCli(["--unknown"], output.io, "9.8.7");

    assert.equal(exitCode, 2);
    assert.match(output.stderr(), /T2O_CLI_INVALID_ARGUMENTS/);
    assert.doesNotMatch(output.stderr(), /\n\s+at /);
  });

  it("requires a target and checkpoint destination before migration", async () => {
    const output = captureIO();

    const exitCode = await runCli(["migrate"], output.io, "9.8.7");

    assert.equal(exitCode, 2);
    assert.match(output.stderr(), /T2O_CLI_INVALID_ARGUMENTS/);
    assert.equal(output.stdout(), "");
  });

  it("parses manifest and resume options and rejects incompatible combinations", async () => {
    for (const args of [
      ["verify", "--manifest", "private-path"],
      ["scan", "--resume", "private-path"],
      ["migrate", "--dry-run", "--resume", "private-path"],
      ["migrate", "--output", "private-path", "--resume", "private-path"],
    ]) {
      const output = captureIO();
      assert.equal(await runCli([...args, "--json"], output.io, "9.8.7"), 2);
      assert.equal(JSON.parse(output.stderr()).code, "T2O_CLI_INVALID_ARGUMENTS");
      assert.doesNotMatch(output.stderr(), /private-path/);
    }
  });

  it("restricts credential redaction to live exports", async () => {
    for (const args of [
      ["migrate", "--redact-credentials"],
      [
        "export",
        "--input",
        "fixtures/ir/v1/valid-trae-assembled.json",
        "--output",
        "private-output",
        "--redact-credentials",
      ],
    ]) {
      const output = captureIO();
      assert.equal(await runCli([...args, "--json"], output.io, "9.8.7"), 2);
      assert.equal(JSON.parse(output.stderr()).code, "T2O_CLI_INVALID_ARGUMENTS");
      assert.doesNotMatch(output.stderr(), /private-output/);
    }
  });

  it("parses a TRAE root override without exposing the path", async () => {
    const output = captureIO();
    const privateRoot = "/Users/private/Library/Application Support/Trae CN";

    const exitCode = await runCli(
      ["scan", "--trae-root", privateRoot],
      output.io,
      "9.8.7",
    );

    assert.equal(exitCode, 4);
    assert.match(output.stderr(), /T2O_TRAE_(ROOT_NOT_FOUND|PLATFORM_UNSUPPORTED|VERSION_UNAVAILABLE)/);
    assert.doesNotMatch(output.stderr(), new RegExp(privateRoot));
  });

  it("emits structured errors without echoing unknown command text", async () => {
    const output = captureIO();
    const privateCommand = "private conversation body";

    const exitCode = await runCli(
      ["--json", privateCommand],
      output.io,
      "9.8.7",
      {
        clock: () => new Date("2026-09-23T06:20:00.000Z"),
      },
    );

    assert.equal(exitCode, 2);
    assert.equal(output.stdout(), "");
    assert.doesNotMatch(output.stderr(), new RegExp(privateCommand));
    assert.deepStrictEqual(JSON.parse(output.stderr()), {
      timestamp: "2026-09-23T06:20:00.000Z",
      level: "error",
      event: "cli.error",
      message: "Unknown command.",
      code: "T2O_CLI_UNKNOWN_COMMAND",
      context: {
        diagnosticIds: [],
        exitCode: 2,
      },
    });
  });

  it("emits a machine-readable version", async () => {
    const output = captureIO();

    const exitCode = await runCli(
      ["--json", "--version"],
      output.io,
      "9.8.7",
    );

    assert.equal(exitCode, 0);
    assert.equal(output.stdout(), '{"version":"9.8.7"}\n');
    assert.equal(output.stderr(), "");
  });

  it("prints an offline preview as one JSON record and rejects empty selection", async () => {
    const output = captureIO();
    const args = ["preview", "--input", "fixtures/ir/v1/valid-trae-assembled.json", "--json"];
    assert.equal(await runCli(args, output.io, "9.8.7"), 0);
    assert.equal(JSON.parse(output.stdout()).sessions[0].messageCount, 2);
    assert.equal(output.stdout().trim().split("\n").length, 1);
    const missing = captureIO();
    assert.equal(await runCli([...args, "--session", "absent-session"], missing.io, "9.8.7"), 4);
    assert.equal(JSON.parse(missing.stderr()).code, "T2O_MIGRATION_SELECTION_EMPTY");
  });
});
