import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { exportBundleFile, readBundleFile } from "../../migration/bundle-file.js";
import type { MigrationManifest } from "../../migration/manifest.js";
import type { TraeSessionMetadata } from "../../source/trae/session-metadata.js";
import {
  buildSessionChoices,
  bundleMatchesSession,
  cleanupObsoleteArtifacts,
  cliJsonResult,
  formatMetadataStatus,
  isTerminalManifestForSession,
  localServerUrl,
  parseChoiceIndex,
  prepareExportDirectory,
  resolveMigrationDirectories,
} from "../interactive-migrate.js";

function session(
  sourceSessionId: string,
  metadataStatus: TraeSessionMetadata["metadataStatus"],
  workspaceStorageIds: string[] = [],
): TraeSessionMetadata {
  return {
    sourceSessionId,
    metadataStatus,
    workspaceStorageIds,
    sources: [],
  };
}

describe("interactive migration helpers", () => {
  it("parses only visible one-based choices within the list", () => {
    assert.equal(parseChoiceIndex("1", 3), 0);
    assert.equal(parseChoiceIndex(" 3 ", 3), 2);
    assert.equal(parseChoiceIndex("0", 3), undefined);
    assert.equal(parseChoiceIndex("4", 3), undefined);
    assert.equal(parseChoiceIndex("abc", 3), undefined);
  });

  it("reads the final structured CLI result without exposing progress text", () => {
    assert.deepEqual(
      cliJsonResult('progress\n{"ready":1,"blocked":0}\n'),
      { ready: 1, blocked: 0 },
    );
    assert.equal(cliJsonResult("progress only"), undefined);
  });

  it("extracts only a loopback OpenCode server URL", () => {
    assert.equal(
      localServerUrl("opencode server listening on http://127.0.0.1:43127"),
      "http://127.0.0.1:43127",
    );
    assert.equal(localServerUrl("http://example.test:43127"), undefined);
  });

  it("labels metadata status without presenting it as final recovery", () => {
    assert.equal(formatMetadataStatus("complete"), "元数据完整");
    assert.equal(formatMetadataStatus("partial"), "元数据部分可用");
    assert.equal(formatMetadataStatus("invalid"), "元数据有问题");
    assert.equal(formatMetadataStatus("other"), "元数据状态未知");
  });

  it("builds readable session choices from runtime metadata", () => {
    const choices = buildSessionChoices(
      [session("session-a", "partial"), session("session-b", "complete")],
      [{
        chat_session_id: "session-a",
        title: "  Project   notes ",
        updated_at: "1724939164000",
      }],
    );

    assert.deepEqual(choices, [
      {
        id: "session-a",
        title: "Project notes",
        metadataStatus: "元数据部分可用",
        updatedAt: 1724939164000,
      },
      {
        id: "session-b",
        title: "未命名会话",
        metadataStatus: "元数据完整",
        updatedAt: undefined,
      },
    ]);
  });

  it("uses stable opaque directories per selected session", () => {
    const root = "/tmp/trae2opencode";
    const sourceSessionId = "private-source-session-a";
    const first = resolveMigrationDirectories(root, sourceSessionId);
    const same = resolveMigrationDirectories(root, sourceSessionId);
    const second = resolveMigrationDirectories(root, "session-b");
    const updated = resolveMigrationDirectories(
      root,
      sourceSessionId,
      undefined,
      undefined,
      2_000,
    );

    assert.deepEqual(first, same);
    assert.notEqual(first.exportDirectory, second.exportDirectory);
    assert.notEqual(first.exportDirectory, updated.exportDirectory);
    assert.match(first.exportDirectory, /trae-export\/session-[a-f0-9]{16}$/);
    assert.doesNotMatch(first.exportDirectory, new RegExp(sourceSessionId));
    assert.deepEqual(
      resolveMigrationDirectories(root, "session-a", "/tmp/export", "/tmp/run"),
      { exportDirectory: "/tmp/export", runDirectory: "/tmp/run" },
    );
  });

  it("accepts only a single bundle for the selected session", async () => {
    const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
    const sourceSessionId = bundle.sessions[0].sourceId;

    assert.equal(bundleMatchesSession(bundle, sourceSessionId), true);
    assert.equal(bundleMatchesSession(bundle, "different-session"), false);
  });

  it("releases only an empty export directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "trae2opencode-interactive-"));
    const absent = path.join(root, "absent");
    const empty = path.join(root, "empty");
    const occupied = path.join(root, "occupied");
    await fs.mkdir(empty);
    await fs.mkdir(occupied);
    await fs.writeFile(path.join(occupied, "private.txt"), "content");
    try {
      assert.equal(await prepareExportDirectory(absent), true);
      assert.equal(await prepareExportDirectory(empty), true);
      assert.equal(await fs.stat(empty).catch(() => undefined), undefined);
      assert.equal(await prepareExportDirectory(occupied), false);
      assert.equal(await fs.readFile(path.join(occupied, "private.txt"), "utf8"), "content");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes only terminal manifests for the selected source session", () => {
    const manifest = {
      sessions: [{ sourceId: "session-a", state: "verified" }],
    } as unknown as MigrationManifest;
    assert.equal(isTerminalManifestForSession(manifest, "session-a"), true);
    manifest.sessions[0].state = "failed";
    assert.equal(isTerminalManifestForSession(manifest, "session-a"), false);
    manifest.sessions[0].state = "verified";
    assert.equal(isTerminalManifestForSession(manifest, "session-b"), false);
  });

  it("cleans only validated obsolete exports for the selected session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "trae2opencode-cleanup-"));
    const exportRoot = path.join(root, "trae-export");
    const runRoot = path.join(root, "migration-run");
    const current = path.join(exportRoot, "session-1111111111111111");
    const obsolete = path.join(exportRoot, "session-2222222222222222");
    const other = path.join(exportRoot, "session-3333333333333333");
    const invalidRun = path.join(runRoot, "session-4444444444444444");
    await fs.mkdir(exportRoot);
    await fs.mkdir(runRoot);
    const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
    const otherBundle = structuredClone(bundle);
    otherBundle.sessions[0].sourceId = "another-session";
    await exportBundleFile(bundle, current);
    await exportBundleFile(bundle, obsolete);
    await exportBundleFile(otherBundle, other);
    await fs.mkdir(invalidRun);
    await fs.writeFile(path.join(invalidRun, "unrelated.txt"), "keep");
    try {
      assert.deepEqual(await cleanupObsoleteArtifacts({
        sourceSessionId: bundle.sessions[0].sourceId,
        exportRoot,
        runRoot,
        currentExportDirectory: current,
        currentRunDirectory: path.join(runRoot, "session-5555555555555555"),
      }), { exportDirectories: 1, runDirectories: 0 });
      await assert.rejects(fs.stat(obsolete), { code: "ENOENT" });
      assert.equal((await fs.stat(current)).isDirectory(), true);
      assert.equal((await fs.stat(other)).isDirectory(), true);
      assert.equal(await fs.readFile(path.join(invalidRun, "unrelated.txt"), "utf8"), "keep");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
