import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  desktopOpenCodeBinaryCandidates,
  discoverOpenCodeTargets,
  preferredOpenCodeTargets,
  requestedOpenCodeTargets,
  type OpenCodeTargetCandidate,
} from "../opencode-targets.js";

const v1: OpenCodeTargetCandidate = {
  dialect: "v1", version: "1.18.32", binary: "/bin/v1", source: "desktop",
};
const v2: OpenCodeTargetCandidate = {
  dialect: "v2", version: "2.0.18", binary: "/bin/v2", source: "path",
};

describe("OpenCode target discovery", () => {
  it("includes the bundled desktop CLI locations on macOS and Windows", () => {
    assert.deepEqual(desktopOpenCodeBinaryCandidates({
      platform: "darwin", homeDirectory: "/Users/example", env: {},
    }), [
      "/Applications/OpenCode.app/Contents/Resources/opencode-cli",
      "/Users/example/Applications/OpenCode.app/Contents/Resources/opencode-cli",
    ]);
    const windows = desktopOpenCodeBinaryCandidates({
      platform: "win32",
      homeDirectory: "C:\\Users\\example",
      env: {
        LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
    });
    assert.ok(windows.includes(
      "C:\\Users\\example\\AppData\\Local\\Programs\\OpenCode\\resources\\opencode-cli.exe",
    ));
    assert.ok(windows.includes("C:\\Program Files\\OpenCode\\Resources\\opencode.exe"));
  });

  it("preserves the legacy explicit binary as a single target", async () => {
    const inspected: string[] = [];
    const targets = await discoverOpenCodeTargets({
      platform: "darwin",
      env: { T2O_OPENCODE_BINARY: "/configured/opencode" },
      isFile: () => false,
      inspectBinary: async (binary) => {
        inspected.push(binary);
        return { dialect: "v2", version: "2.0.18" };
      },
    });
    assert.deepEqual(inspected, ["/configured/opencode"]);
    assert.deepEqual(targets, [{
      dialect: "v2", version: "2.0.18",
      binary: "/configured/opencode", source: "configured",
    }]);
  });

  it("discovers a PATH CLI and desktop CLI as separate dialect targets", async () => {
    const desktop = "/Applications/OpenCode.app/Contents/Resources/opencode-cli";
    const targets = await discoverOpenCodeTargets({
      platform: "darwin",
      env: {},
      homeDirectory: "/Users/example",
      isFile: (filename) => filename === desktop,
      inspectBinary: async (binary) => binary === "opencode"
        ? { dialect: "v2", version: "2.0.18" }
        : { dialect: "v1", version: "1.18.32" },
    });
    assert.deepEqual(targets, [
      { dialect: "v2", version: "2.0.18", binary: "opencode", source: "path" },
      { dialect: "v1", version: "1.18.32", binary: desktop, source: "desktop" },
    ]);
  });

  it("fails closed when a version-specific binary has the wrong dialect", async () => {
    await assert.rejects(discoverOpenCodeTargets({
      platform: "darwin",
      env: { T2O_OPENCODE_V1_BINARY: "/configured/v2" },
      isFile: () => false,
      inspectBinary: async () => ({ dialect: "v2", version: "2.0.18" }),
    }), /OPENCODE_BINARY_DIALECT_MISMATCH/);
  });

  it("keeps one candidate per dialect and matches an active desktop service", () => {
    const candidates: OpenCodeTargetCandidate[] = [
      { dialect: "v2", version: "2.0.18", binary: "/path/v2", source: "path" },
      { dialect: "v2", version: "2.0.16", binary: "/desktop/v2", source: "desktop" },
      v1,
    ];
    assert.deepEqual(preferredOpenCodeTargets(candidates, { v2: "2.0.16" }), [
      v1,
      candidates[1],
    ]);
    const configured = {
      ...candidates[0], source: "configured" as const,
    };
    assert.equal(preferredOpenCodeTargets([configured, candidates[1]])[0], configured);
  });

  it("selects one or both available dialects for unattended migration", () => {
    assert.equal(requestedOpenCodeTargets(undefined, [v1, v2]), undefined);
    assert.deepEqual(requestedOpenCodeTargets("v1", [v1, v2]), [v1]);
    assert.deepEqual(requestedOpenCodeTargets("v1 | v2", [v1, v2]), [v1, v2]);
    assert.deepEqual(requestedOpenCodeTargets("all", [v2]), [v2]);
    assert.throws(() => requestedOpenCodeTargets("v3", [v1, v2]),
      /OPENCODE_TARGET_SELECTION_INVALID/);
    assert.throws(() => requestedOpenCodeTargets("v1,v2", [v1]),
      /OPENCODE_TARGET_UNAVAILABLE/);
  });

  it("uses path semantics only for the configured host", async () => {
    const target = (await discoverOpenCodeTargets({
      platform: "darwin",
      env: { T2O_OPENCODE_V2_BINARY: "./relative-opencode" },
      isFile: () => false,
      inspectBinary: async () => ({ dialect: "v2", version: "2.0.18" }),
    }))[0];
    assert.equal(target.binary, "./relative-opencode");
    assert.equal(path.isAbsolute(target.binary), false);
  });
});
