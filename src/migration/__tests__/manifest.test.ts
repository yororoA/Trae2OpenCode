import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { hashCanonicalJson } from "../../ir/canonical.js";
import { readBundleFile } from "../bundle-file.js";
import { migrate } from "../executor.js";
import { buildMigrationPlan } from "../plan.js";
import { readManifest, withManifestStore, type MigrationManifest } from "../manifest.js";

const hash = hashCanonicalJson("synthetic");
function emptyManifest(): MigrationManifest {
  return {
    manifestVersion: 1, runId: "11111111-1111-4111-8111-111111111111",
    sourceFingerprint: hash, irHash: hash, planHash: hash,
    target: { endpointHash: hash, binaryVersion: "2.0.12", serverVersion: "2.0.12", schemaHash: hash, fingerprint: hash },
    revision: 0, sessions: [], checksum: "",
  };
}
async function temporary(operation: (filename: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-manifest-"));
  try { await operation(path.join(directory, "migration-manifest.json")); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

describe("migration manifest persistence", () => {
  it("atomically checkpoints with a checksum and private file permissions", () => temporary(async (filename) => {
    const manifest = emptyManifest();
    await withManifestStore(filename, async (store) => {
      await store.save(manifest);
      assert.equal(manifest.revision, 1);
      assert.deepEqual(await store.read(), manifest);
      await store.save(manifest);
      assert.equal((await store.read()).revision, 2);
    });
    assert.deepEqual(await readManifest(filename), manifest);
    if (process.platform !== "win32") assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.deepEqual((await fs.readdir(path.dirname(filename))).sort(), [
      "migration-manifest.json", "migration-manifest.json.lock",
    ]);
  }));

  it("rejects concurrent users of a checkpoint and releases the lock after failure", () => temporary(async (filename) => {
    await assert.rejects(withManifestStore(filename, async () => {
      await assert.rejects(withManifestStore(filename, async () => assert.fail("Concurrent writer")),
        { code: "T2O_MIGRATION_LOCKED" });
      throw new Error("operation failed");
    }), /operation failed/);
    await withManifestStore(filename, async (store) => store.save(emptyManifest()));
    assert.equal((await readManifest(filename)).revision, 1);
  }));

  it("keeps the last durable checkpoint when a replacement is invalid", () => temporary(async (filename) => {
    await withManifestStore(filename, async (store) => {
      const manifest = emptyManifest();
      await store.save(manifest);
      manifest.runId = "invalid";
      await assert.rejects(store.save(manifest), { code: "T2O_MIGRATION_CHECKPOINT_FAILED" });
      assert.equal((await store.read()).runId, "11111111-1111-4111-8111-111111111111");
      assert.equal((await store.read()).revision, 1);
    });
  }));

  it("rejects tampered, unknown and malformed checkpoint contents", () => temporary(async (filename) => {
    await withManifestStore(filename, async (store) => {
      const manifest = emptyManifest();
      await store.save(manifest);
      for (const value of [{ ...manifest, revision: 100 }, { ...manifest, extra: "private" }, null, "{"]) {
        await fs.writeFile(filename, JSON.stringify(value));
        await assert.rejects(store.read(), { code: "T2O_MIGRATION_MANIFEST_INVALID" });
      }
    });
  }));

  it("refuses a symlink or hard link used as the manifest or lock", () => temporary(async (filename) => {
    const target = path.join(path.dirname(filename), "target.json");
    await fs.writeFile(target, "{}");
    await fs.link(target, filename);
    await assert.rejects(readManifest(filename), { code: "T2O_MIGRATION_MANIFEST_INVALID" });
    await fs.link(target, `${filename}.lock`);
    await assert.rejects(withManifestStore(filename, async () => assert.fail("Bad lock accepted")),
      { code: "T2O_MIGRATION_CHECKPOINT_FAILED" });
    assert.equal(await fs.readFile(target, "utf8"), "{}");
  }));

  it("rejects inconsistent deletion evidence and replacement checkpoints", () => temporary(async (filename) => {
    const plan = await buildMigrationPlan(await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json"), {
      fallbackDirectory: path.dirname(filename),
    });
    const outputDirectory = path.join(path.dirname(filename), "run");
    const result = await migrate(plan, {
      async describe() { return emptyManifest().target; },
      async readSession() { return null; },
      async importSession() { throw new Error("simulated failure"); },
    }, { outputDirectory });
    const source = path.join(outputDirectory, result.manifest);
    await withManifestStore(source, async (store) => {
      const original = await store.read();
      const invalidHash = structuredClone(original);
      invalidHash.sessions[0].deletionHash = hash;
      await assert.rejects(store.save(invalidHash), { code: "T2O_MIGRATION_CHECKPOINT_FAILED" });
      const prematureImport = structuredClone(original);
      prematureImport.sessions[0].replacement = {
        runId: emptyManifest().runId, deletionHash: hash, state: "deleting",
      };
      await assert.rejects(store.save(prematureImport), { code: "T2O_MIGRATION_CHECKPOINT_FAILED" });
      const recursive = structuredClone(original);
      recursive.sessions[0].replacement = { runId: original.runId, deletionHash: hash, state: "deleted" };
      await assert.rejects(store.save(recursive), { code: "T2O_MIGRATION_CHECKPOINT_FAILED" });
      const unsealed = structuredClone(original);
      unsealed.sessions[0].state = "rolled-back";
      await assert.rejects(store.save(unsealed), { code: "T2O_MIGRATION_CHECKPOINT_FAILED" });
      const noEvidence = structuredClone(original);
      noEvidence.rollbackState = "in-progress";
      noEvidence.sessions[0].state = "deleting";
      await assert.rejects(store.save(noEvidence), { code: "T2O_MIGRATION_CHECKPOINT_FAILED" });
      const incomplete = structuredClone(original);
      incomplete.rollbackState = "completed";
      incomplete.sessions[0].created = true;
      incomplete.sessions[0].deletionHash = hash;
      incomplete.sessions[0].state = "deleting";
      await assert.rejects(store.save(incomplete), { code: "T2O_MIGRATION_CHECKPOINT_FAILED" });
      assert.deepEqual(await store.read(), original);
    });
  }));
});
