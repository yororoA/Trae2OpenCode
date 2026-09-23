import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
  it("prints help when no command is provided", () => {
    const output = captureIO();

    const exitCode = runCli([], output.io, "9.8.7");

    assert.equal(exitCode, 0);
    assert.match(output.stdout(), /Trae2OpenCode 9\.8\.7/);
    assert.match(output.stdout(), /trae2opencode <command>/);
    assert.equal(output.stderr(), "");
  });

  it("prints the package version", () => {
    const output = captureIO();

    const exitCode = runCli(["--version"], output.io, "9.8.7");

    assert.equal(exitCode, 0);
    assert.equal(output.stdout(), "9.8.7\n");
    assert.equal(output.stderr(), "");
  });

  it("rejects unknown options without exposing a stack trace", () => {
    const output = captureIO();

    const exitCode = runCli(["--unknown"], output.io, "9.8.7");

    assert.equal(exitCode, 2);
    assert.match(output.stderr(), /T2O_CLI_INVALID_ARGUMENTS/);
    assert.doesNotMatch(output.stderr(), /\n\s+at /);
  });

  it("keeps planned migration commands disabled", () => {
    const output = captureIO();

    const exitCode = runCli(["migrate"], output.io, "9.8.7");

    assert.equal(exitCode, 2);
    assert.equal(
      output.stderr(),
      "Error [T2O_CLI_COMMAND_NOT_IMPLEMENTED]: " +
        "This command is not implemented yet.\n",
    );
  });

  it("parses a TRAE root override without exposing the path", () => {
    const output = captureIO();
    const privateRoot = "/Users/private/Library/Application Support/Trae CN";

    const exitCode = runCli(
      ["scan", "--trae-root", privateRoot],
      output.io,
      "9.8.7",
    );

    assert.equal(exitCode, 2);
    assert.match(output.stderr(), /T2O_CLI_COMMAND_NOT_IMPLEMENTED/);
    assert.doesNotMatch(output.stderr(), new RegExp(privateRoot));
  });

  it("emits structured errors without echoing unknown command text", () => {
    const output = captureIO();
    const privateCommand = "private conversation body";

    const exitCode = runCli(
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

  it("emits a machine-readable version", () => {
    const output = captureIO();

    const exitCode = runCli(
      ["--json", "--version"],
      output.io,
      "9.8.7",
    );

    assert.equal(exitCode, 0);
    assert.equal(output.stdout(), '{"version":"9.8.7"}\n');
    assert.equal(output.stderr(), "");
  });
});
