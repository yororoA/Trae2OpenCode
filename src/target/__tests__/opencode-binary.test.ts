import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveOpenCodeBinary } from "../opencode/binary.js";

const shimDirectory = path.win32.join("C:\\", "Users", "synthetic", "npm");
const npmShim = path.win32.join(shimDirectory, "opencode.cmd");
const nativeBinary = path.win32.join(shimDirectory, "node_modules", "opencode-ai", "bin", "opencode.exe");

function windowsOptions(files: Record<string, string>, existing = Object.keys(files)) {
  return {
    platform: "win32" as NodeJS.Platform,
    env: { PATH: shimDirectory },
    isFile: (candidate: string) => existing.includes(path.resolve(candidate)),
    readText: (candidate: string) => files[path.resolve(candidate)],
  };
}

describe("resolveOpenCodeBinary", () => {
  it("leaves other platforms and already-spawnable paths untouched", () => {
    assert.equal(resolveOpenCodeBinary("opencode", { platform: "darwin", env: {} }), "opencode");
    assert.equal(
      resolveOpenCodeBinary("C:\\tools\\opencode.exe", windowsOptions({}, [])),
      "C:\\tools\\opencode.exe",
    );
    assert.equal(
      resolveOpenCodeBinary("opencode", windowsOptions({}, [nativeBinary])),
      "opencode",
    );
  });

  it("resolves the native executable inside an npm cmd shim", () => {
    const files = {
      [npmShim]: [
        "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start",
        "SETLOCAL", "CALL :find_dp0",
        "\"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe\"   %*",
      ].join("\r\n"),
    };
    const resolved = resolveOpenCodeBinary("opencode", windowsOptions(files, Object.keys(files).concat(nativeBinary)));
    assert.equal(resolved, nativeBinary);
  });

  it("resolves the native executable inside a POSIX-style shim", () => {
    const shellShim = path.win32.join(shimDirectory, "opencode");
    const files = {
      [shellShim]: [
        "#!/bin/sh",
        "basedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")",
        `exec "$basedir/node_modules/opencode-ai/bin/opencode.exe"   "$@"`,
      ].join("\n"),
    };
    const resolved = resolveOpenCodeBinary("opencode", windowsOptions(files, Object.keys(files).concat(nativeBinary)));
    assert.equal(resolved, nativeBinary);
  });

  it("never returns a node-hosted shim as the OpenCode executable", () => {
    const jsShim = path.win32.join(shimDirectory, "opencode.cmd");
    const nodeExe = path.win32.join(shimDirectory, "node.exe");
    const files = {
      [jsShim]: ["@ECHO off", "\"%dp0%\\node.exe\" \"%dp0%\\node_modules\\pkg\\cli.js\" %*"].join("\r\n"),
    };
    const resolved = resolveOpenCodeBinary("opencode", windowsOptions(files, [jsShim, nodeExe]));
    assert.equal(resolved, "opencode");
  });

  it("keeps the configured name when nothing resolves", () => {
    assert.equal(resolveOpenCodeBinary("missing-cli", windowsOptions({}, [])), "missing-cli");
    assert.equal(resolveOpenCodeBinary("", windowsOptions({}, [])), "");
  });

  it("uses the real filesystem for the default probes", () => {
    // The repository itself is a file on every platform, so it must be returned unchanged.
    assert.equal(resolveOpenCodeBinary(path.resolve("package.json")), path.resolve("package.json"));
    assert.ok(existsSync(path.resolve("package.json")));
  });
});