import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveOpenCodeDirectory } from "../opencode/project-directory.js";

describe("OpenCode project directory policy", () => {
  it("preserves existing original directories without rewriting the source path", async () => {
    const result = await resolveOpenCodeDirectory({
      sourcePath: "/repo/./中文", sourcePlatform: "darwin", targetPlatform: "darwin",
      directoryExists: async (value) => value === "/repo/中文",
    });
    assert.deepEqual(result, {
      sourcePath: "/repo/中文", targetDirectory: "/repo/中文", strategy: "preserved",
      exists: true, writable: true, reasons: [],
    });
  });

  it("upper-cases a Windows drive letter so plans match the directory OpenCode stores", async () => {
    const result = await resolveOpenCodeDirectory({
      sourcePath: "e:\\Desktop\\desktop\\daily\\fun\\repo", sourcePlatform: "win32", targetPlatform: "win32",
      directoryExists: async () => true,
    });
    assert.equal(result.strategy, "preserved");
    assert.equal(result.sourcePath, "E:\\Desktop\\desktop\\daily\\fun\\repo");
    assert.equal(result.targetDirectory, "E:\\Desktop\\desktop\\daily\\fun\\repo");
    const unc = await resolveOpenCodeDirectory({
      sourcePath: "\\\\Server\\Share\\folder", sourcePlatform: "win32", targetPlatform: "win32",
      directoryExists: async () => true,
    });
    assert.equal(unc.targetDirectory, "\\\\Server\\Share\\folder");
  });

  it("maps the longest component prefix and never matches a similarly named sibling", async () => {
    const options = {
      sourcePlatform: "darwin" as const, targetPlatform: "darwin" as const,
      pathMaps: [{ from: "/repo", to: "/target" }, { from: "/repo/nested", to: "/specific" }],
      directoryExists: async () => true,
    };
    assert.equal((await resolveOpenCodeDirectory({ ...options, sourcePath: "/repo/nested/a" })).targetDirectory,
      "/specific/a");
    assert.equal((await resolveOpenCodeDirectory({ ...options, sourcePath: "/repo-old/a" })).targetDirectory,
      "/repo-old/a");
    assert.equal((await resolveOpenCodeDirectory({
      ...options, sourcePath: "/nested", pathMaps: [{ from: "/", to: "/target" }],
    })).targetDirectory, "/target/nested");
  });

  it("uses Windows drive, case and UNC semantics when mapping to POSIX", async () => {
    const base = {
      sourcePlatform: "win32" as const, targetPlatform: "darwin" as const,
      directoryExists: async () => true,
    };
    const drive = await resolveOpenCodeDirectory({
      ...base, sourcePath: "c:\\Repo\\Project", pathMaps: [{ from: "C:\\repo", to: "/target" }],
    });
    assert.equal(drive.targetDirectory, "/target/Project");
    const unc = await resolveOpenCodeDirectory({
      ...base, sourcePath: "\\\\Server\\Share\\folder", pathMaps: [{ from: "//server/share", to: "/target" }],
    });
    assert.equal(unc.targetDirectory, "/target/folder");
  });

  it("maps POSIX to Windows without converting backslashes inside source filenames", async () => {
    const base = {
      sourcePlatform: "darwin" as const, targetPlatform: "win32" as const,
      directoryExists: async () => true, pathMaps: [{ from: "/repo", to: "D:\\target" }],
    };
    assert.equal((await resolveOpenCodeDirectory({ ...base, sourcePath: "/repo/中文/a" })).targetDirectory,
      "D:\\target\\中文\\a");
    await assert.rejects(resolveOpenCodeDirectory({ ...base, sourcePath: "/repo/a\\b" }),
      { code: "T2O_OPENCODE_PATH_MAP_INVALID" });
    const posix = await resolveOpenCodeDirectory({
      sourcePlatform: "darwin", targetPlatform: "darwin", sourcePath: "/repo/a\\",
      directoryExists: async () => true,
    });
    assert.equal(posix.targetDirectory, "/repo/a\\");
  });

  it("requires an explicit fallback for unavailable or foreign paths", async () => {
    const base = {
      sourcePath: "C:\\repo", sourcePlatform: "win32" as const, targetPlatform: "darwin" as const,
      directoryExists: async (value: string) => value === "/fallback",
    };
    const missing = await resolveOpenCodeDirectory(base);
    assert.equal(missing.writable, false);
    assert.equal(missing.targetDirectory, null);
    assert.deepEqual(missing.reasons, ["T2O_OPENCODE_DIRECTORY_INVALID"]);
    const resolved = await resolveOpenCodeDirectory({ ...base, fallbackDirectory: "/fallback" });
    assert.equal(resolved.strategy, "fallback");
    assert.equal(resolved.sourcePath, "C:\\repo");
    assert.equal(resolved.writable, true);
    const absent = await resolveOpenCodeDirectory({ ...base, sourcePath: undefined, fallbackDirectory: "/fallback" });
    assert.equal(absent.strategy, "fallback");
  });

  it("rejects relative, drive-relative, device, null and conflicting map paths", async () => {
    for (const sourcePath of ["relative", "C:relative", "\\relative", "\\\\?\\C:\\repo"]) {
      await assert.rejects(resolveOpenCodeDirectory({ sourcePath, sourcePlatform: "win32" }),
        { code: "T2O_OPENCODE_PATH_MAP_INVALID" });
    }
    await assert.rejects(resolveOpenCodeDirectory({ sourcePath: "/repo\0x", sourcePlatform: "darwin" }),
      { code: "T2O_OPENCODE_PATH_MAP_INVALID" });
    await assert.rejects(resolveOpenCodeDirectory({
      sourcePath: "/repo", sourcePlatform: "darwin", targetPlatform: "darwin",
      pathMaps: [{ from: "/repo", to: "/one" }, { from: "/repo/", to: "/two" }],
    }), { code: "T2O_OPENCODE_PATH_MAP_INVALID" });
  });

  it("checks the filesystem read-only and does not create a missing project", async () => {
    await fs.mkdir("tmp", { recursive: true });
    const root = await fs.mkdtemp(path.resolve("tmp", "directory-test-"));
    const sourcePlatform = process.platform === "win32" ? "win32" : "darwin";
    try {
      const result = await resolveOpenCodeDirectory({ sourcePath: root, sourcePlatform });
      assert.equal(result.writable, true);
      const missing = await resolveOpenCodeDirectory({
        sourcePath: path.join(root, "missing"), sourcePlatform,
      });
      assert.equal(missing.strategy, "preserved");
      assert.equal(missing.writable, false);
      assert.deepEqual(await fs.readdir(root), []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
