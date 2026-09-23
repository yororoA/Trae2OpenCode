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

    assert.equal(exitCode, 1);
    assert.match(output.stderr(), /--unknown/);
    assert.doesNotMatch(output.stderr(), /\n\s+at /);
  });

  it("keeps planned migration commands disabled", () => {
    const output = captureIO();

    const exitCode = runCli(["migrate"], output.io, "9.8.7");

    assert.equal(exitCode, 2);
    assert.equal(
      output.stderr(),
      'Command "migrate" is not implemented yet.\n',
    );
  });
});
