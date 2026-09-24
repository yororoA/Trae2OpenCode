import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { exportBundleFile, readBundleFile } from "../../migration/bundle-file.js";
import { type MigrationManifest, withManifestStore } from "../../migration/manifest.js";
import type { TraeSessionMetadata } from "../../source/trae/session-metadata.js";
import {
  buildSessionChoices,
  bundleMatchesSession,
  cleanupObsoleteArtifacts,
  cliJsonResult,
  confirmsOverwrite,
  createManagedOpenCodeEnvironment,
  findReplacementManifest,
  formatMetadataStatus,
  isReplacementManifestForSession,
  isTerminalManifestForSession,
  localServerUrl,
  parseChoiceIndex,
  parseChoiceIndexes,
  parseOpenCodeServiceDescriptor,
  prepareExportDirectory,
  replacementResumeNeedsExclusiveAccess,
  replacementTargetExists,
  resolveInteractiveMigrationMode,
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

function replacementManifest(
  sourceId: string,
  runId = "00000000-0000-4000-8000-000000000001",
): MigrationManifest {
  const hash = `sha256:${"a".repeat(64)}`;
  const expected = {
    counts: { messages: 1, users: 0, assistants: 1, text: 1, reasoning: 0, tools: 0 },
    messagesSha256: hash,
    infoSha256: hash,
  };
  return {
    manifestVersion: 1,
    runId,
    sourceFingerprint: hash,
    irHash: hash,
    planHash: hash,
    target: {
      endpointHash: hash,
      binaryVersion: "2.0.12",
      serverVersion: "2.0.12",
      schemaHash: hash,
      fingerprint: hash,
    },
    revision: 0,
    sessions: [{
      sourceId,
      targetId: "ses_target",
      state: "verified",
      created: true,
      attempts: 1,
      codes: [],
      transferHash: hash,
      expected,
      actual: expected,
      deletionHash: hash,
    }],
    checksum: "",
  };
}

async function writeManifest(directory: string, manifest: MigrationManifest): Promise<string> {
  await fs.mkdir(directory);
  const filename = path.join(directory, "migration-manifest.json");
  await withManifestStore(filename, async (store) => store.save(manifest));
  return filename;
}

describe("interactive migration helpers", () => {
  it("parses only visible one-based choices within the list", () => {
    assert.equal(parseChoiceIndex("1", 3), 0);
    assert.equal(parseChoiceIndex(" 3 ", 3), 2);
    assert.equal(parseChoiceIndex("0", 3), undefined);
    assert.equal(parseChoiceIndex("4", 3), undefined);
    assert.equal(parseChoiceIndex("abc", 3), undefined);
  });

  it("parses individual, ranged and all session selections", () => {
    assert.deepEqual(parseChoiceIndexes("1, 3-5, 3", 6), [0, 2, 3, 4]);
    assert.deepEqual(parseChoiceIndexes("1，2 4", 4), [0, 1, 3]);
    assert.deepEqual(parseChoiceIndexes("all", 3), [0, 1, 2]);
    assert.deepEqual(parseChoiceIndexes("全部", 2), [0, 1]);
    assert.equal(parseChoiceIndexes("0,1", 3), undefined);
    assert.equal(parseChoiceIndexes("2-1", 3), undefined);
    assert.equal(parseChoiceIndexes("1,4", 3), undefined);
    assert.equal(parseChoiceIndexes("1-two", 3), undefined);
  });

  it("requires an explicit overwrite confirmation", () => {
    assert.equal(confirmsOverwrite("OVERWRITE"), true);
    assert.equal(confirmsOverwrite(" OVERWRITE "), true);
    assert.equal(confirmsOverwrite("overwrite"), false);
    assert.equal(confirmsOverwrite("yes"), false);
  });

  it("isolates the managed service descriptor while retaining the user's target database", () => {
    const environment = createManagedOpenCodeEnvironment("/tmp/managed-opencode", {
      XDG_DATA_HOME: "/Users/example/.local/share",
      OPENCODE_DB: "/Users/example/.local/share/opencode/opencode.db",
      OPENCODE_SERVER_PASSWORD: "private",
      OPENCODE_USERNAME: "private-user",
    });
    assert.equal(environment.XDG_STATE_HOME, "/tmp/managed-opencode");
    assert.equal(environment.XDG_DATA_HOME, "/Users/example/.local/share");
    assert.equal(environment.OPENCODE_DB, "/Users/example/.local/share/opencode/opencode.db");
    assert.equal(environment.OPENCODE_SERVER_PASSWORD, undefined);
    assert.equal(environment.OPENCODE_USERNAME, undefined);
  });

  it("accepts only authenticated OpenCode 2.0.12 loopback service descriptors", () => {
    assert.deepEqual(parseOpenCodeServiceDescriptor({
      url: "http://127.0.0.1:49374",
      version: "2.0.12",
      password: "long-enough-password",
    }), {
      url: "http://127.0.0.1:49374",
      password: "long-enough-password",
    });
    assert.equal(parseOpenCodeServiceDescriptor({
      url: "http://remote.test:49374",
      version: "2.0.12",
      password: "long-enough-password",
    }), undefined);
    assert.equal(parseOpenCodeServiceDescriptor({
      url: "http://127.0.0.1:49374",
      version: "2.0.16",
      password: "long-enough-password",
    }), undefined);
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

  it("accepts only verified tool-owned manifests as replacement evidence", () => {
    const manifest = replacementManifest("session-a");
    assert.equal(isReplacementManifestForSession(manifest, "session-a"), true);
    assert.equal(isReplacementManifestForSession(manifest, "session-b"), false);

    manifest.sessions[0].created = false;
    assert.equal(isReplacementManifestForSession(manifest, "session-a"), false);
    manifest.sessions[0].created = true;
    manifest.sessions[0].state = "skipped";
    assert.equal(isReplacementManifestForSession(manifest, "session-a"), false);
    manifest.sessions[0].state = "verified";
    manifest.rollbackState = "in-progress";
    assert.equal(isReplacementManifestForSession(manifest, "session-a"), false);
  });

  it("requires exclusive access while a replacement deletion is incomplete", () => {
    const manifest = replacementManifest("session-a");
    assert.equal(replacementResumeNeedsExclusiveAccess(manifest), false);
    manifest.sessions[0].replacement = {
      runId: "00000000-0000-4000-8000-000000000002",
      deletionHash: `sha256:${"b".repeat(64)}`,
      state: "pending",
    };
    assert.equal(replacementResumeNeedsExclusiveAccess(manifest), true);
    manifest.sessions[0].replacement.state = "deleted";
    assert.equal(replacementResumeNeedsExclusiveAccess(manifest), false);
  });

  it("selects create, replacement and exclusive resume modes safely", () => {
    const base = {
      manifest: "/private/current/migration-manifest.json",
      runDirectory: "/private/current",
      manifestExists: false,
      runDirectoryExists: false,
      resumeNeedsExclusiveAccess: false,
    };
    assert.deepEqual(resolveInteractiveMigrationMode(base), {
      name: "create",
      args: ["--output", "/private/current"],
    });
    assert.deepEqual(resolveInteractiveMigrationMode({
      ...base,
      replacementManifest: "/private/previous/migration-manifest.json",
    }), {
      name: "replace",
      args: [
        "--output", "/private/current",
        "--replace", "/private/previous/migration-manifest.json",
        "--exclusive-target",
      ],
    });
    assert.deepEqual(resolveInteractiveMigrationMode({
      ...base,
      manifestExists: true,
      resumeNeedsExclusiveAccess: true,
    }), {
      name: "resume",
      args: ["--resume", "/private/current/migration-manifest.json", "--exclusive-target"],
    });
    assert.equal(resolveInteractiveMigrationMode({
      ...base,
      runDirectoryExists: true,
    }), undefined);
  });

  it("finds the newest safe replacement manifest and ignores the current run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "trae2opencode-replacement-"));
    const current = path.join(root, "session-1111111111111111");
    const older = path.join(root, "session-2222222222222222");
    const newest = path.join(root, "session-3333333333333333");
    const unrelated = path.join(root, "session-4444444444444444");
    try {
      await writeManifest(current, replacementManifest("session-a"));
      await writeManifest(older, replacementManifest(
        "session-a",
        "00000000-0000-4000-8000-000000000002",
      ));
      await writeManifest(newest, replacementManifest(
        "session-a",
        "00000000-0000-4000-8000-000000000003",
      ));
      await writeManifest(unrelated, replacementManifest(
        "session-b",
        "00000000-0000-4000-8000-000000000004",
      ));
      await fs.utimes(older, new Date(1_000), new Date(1_000));
      await fs.utimes(newest, new Date(2_000), new Date(2_000));

      assert.equal(await findReplacementManifest({
        sourceSessionId: "session-a",
        runRoot: root,
        currentRunDirectory: current,
      }), path.join(newest, "migration-manifest.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("drops replacement mode when the previously migrated target was deleted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "trae2opencode-target-"));
    try {
      const filename = await writeManifest(
        path.join(root, "session-1111111111111111"),
        replacementManifest("session-a"),
      );
      assert.equal(await replacementTargetExists(filename, async (targetId) => {
        assert.equal(targetId, "ses_target");
        return null;
      }), false);
      assert.equal(await replacementTargetExists(filename, async () => ({ id: "ses_target" })), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
