import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveOpenCodeBinary } from "../opencode/binary.js";

const shimDirectory = path.win32.join("C:\\", "Users", "synthetic", "npm");
const npmShim = path.win32.join(shimDirectory, "opencode.cmd");
const npmPackage = path.win32.join(shimDirectory, "node_modules", "opencode-ai");
const nativeBinary = path.win32.join(npmPackage, "bin", "opencode.exe");
const launcher = path.win32.join(npmPackage, "bin", "opencode");
const avx2Binary = path.win32.join(npmPackage, "node_modules", "opencode-windows-x64", "bin", "opencode.exe");
const baselineBinary = path.win32.join(
  npmPackage, "node_modules", "opencode-windows-x64-baseline", "bin", "opencode.exe",
);

function windowsOptions(files: Record<string, string>, existing = Object.keys(files)) {
  const normalizedFiles = new Map(
    Object.entries(files).map(([filename, content]) => [path.win32.resolve(filename), content]),
  );
  const normalizedExisting = existing.map((filename) => path.win32.resolve(filename));
  return {
    platform: "win32" as NodeJS.Platform,
    arch: "x64",
    env: { PATH: shimDirectory },
    isFile: (candidate: string) => normalizedExisting.includes(path.win32.resolve(candidate)),
    readText: (candidate: string) => normalizedFiles.get(path.win32.resolve(candidate)),
  };
}

/** `opencode-ai` before the platform packages were published as the shim's own target. */
const launcherShim = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start",
  "SETLOCAL", "CALL :find_dp0",
  "IF EXIST \"%dp0%\\node.exe\" (",
  "  SET \"_prog=%dp0%\\node.exe\"",
  ") ELSE (",
  "  SET \"_prog=node\"",
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  " +
    "\"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*",
].join("\r\n");

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

  it("follows a Node launcher shim to the platform package it runs", () => {
    const nodeExe = path.win32.join(shimDirectory, "node.exe");
    const files = { [npmShim]: launcherShim };
    const existing = Object.keys(files).concat(launcher, nodeExe, baselineBinary, avx2Binary);
    assert.equal(resolveOpenCodeBinary("opencode", windowsOptions(files, existing)), baselineBinary);
  });

  it("accepts the only platform build when the baseline one is absent", () => {
    const nodeExe = path.win32.join(shimDirectory, "node.exe");
    const files = { [npmShim]: launcherShim };
    const existing = Object.keys(files).concat(launcher, nodeExe, avx2Binary);
    assert.equal(resolveOpenCodeBinary("opencode", windowsOptions(files, existing)), avx2Binary);
  });

  it("keeps the configured name when a launcher has no platform package", () => {
    const nodeExe = path.win32.join(shimDirectory, "node.exe");
    const files = { [npmShim]: launcherShim };
    const existing = Object.keys(files).concat(launcher, nodeExe);
    assert.equal(resolveOpenCodeBinary("opencode", windowsOptions(files, existing)), "opencode");
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
