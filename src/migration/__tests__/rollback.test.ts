import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import type { OpenCodeTransfer } from "../../target/opencode/mapping.js";
import { readBundleFile } from "../bundle-file.js";
import { migrate, verifyMigration } from "../executor.js";
import { readManifest, withManifestStore, type MigrationManifest } from "../manifest.js";
import { jsonHash } from "../ownership.js";
import { buildMigrationPlan } from "../plan.js";
import { rollbackMigration } from "../rollback.js";
import type { MigrationTarget } from "../target.js";

async function setup(operation: (ctx: {
  root: string; filename: string; runId: string; plan: Awaited<ReturnType<typeof buildMigrationPlan>>;
  api: MigrationTarget; sessions: Map<string, OpenCodeTransfer>; deleted: string[];
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-rollback-"));
  try {
    const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
    const child = JSON.parse(JSON.stringify(bundle.sessions[0]).replaceAll("session-synthetic", "session-child"));
    child.parentSourceId = bundle.sessions[0].sourceId;
    bundle.sessions.push(child);
    const plan = await buildMigrationPlan(bundle, { fallbackDirectory: root });
    const sessions = new Map<string, OpenCodeTransfer>();
    const deleted: string[] = [];
    const hash = jsonHash("target");
    const api: MigrationTarget = {
      async describe() {
        return { endpointHash: hash, fingerprint: hash, schemaHash: hash, binaryVersion: "2.0.12", serverVersion: "2.0.12" };
      },
      async readSession(id) { return structuredClone(sessions.get(id) ?? null); },
      async importSession(transfer) {
        assert.ok(!sessions.has(transfer.info.id));
        sessions.set(transfer.info.id, structuredClone(transfer));
        return structuredClone(transfer);
      },
      async listChildren(id) {
        return [...sessions.values()].filter((item) => item.info.parentID === id).map((item) => item.info.id);
      },
      async deleteSession(id, expected, exclusive) {
        assert.equal(exclusive, true);
        assert.equal(jsonHash(sessions.get(id)), expected);
        assert.deepEqual(await api.listChildren!(id), []);
        sessions.delete(id);
        deleted.push(id);
      },
    };
    const outputDirectory = path.join(root, "run");
    const result = await migrate(plan, api, { outputDirectory });
    assert.equal(result.verified, 2);
    await operation({ root, filename: path.join(outputDirectory, result.manifest), runId: result.runId,
      plan, api, sessions, deleted });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

const confirm = (runId: string) => ({ confirm: runId, exclusiveTarget: true });
async function edit(filename: string, operation: (manifest: MigrationManifest) => void) {
  await withManifestStore(filename, async (store) => {
    const manifest = await store.read();
    operation(manifest);
    await store.save(manifest);
  });
}

describe("rollback of sessions newly created by one run", () => {
  it("previews without changing the manifest or deleting sessions", () => setup(async ({ filename, api, deleted }) => {
    const before = await fs.readFile(filename, "utf8");
    const report = await rollbackMigration(filename, api);
    assert.equal(report.preview, true);
    assert.equal(report.eligible, 2);
    assert.equal(report.hasFailures, false);
    assert.equal(report.rollbackState, "not-started");
    assert.equal(await fs.readFile(filename, "utf8"), before);
    assert.deepEqual(deleted, []);
    assert.doesNotMatch(JSON.stringify(report), /Read this file|First persisted|metadata|deletionHash/);
  }));

  it("requires the exact run ID and exclusive use before any target call", () => setup(async ({ filename, runId, api, deleted }) => {
    api.describe = async () => assert.fail("Target must not be called");
    await assert.rejects(rollbackMigration(filename, api, { confirm: runId }),
      { code: "T2O_MIGRATION_EXCLUSIVE_REQUIRED" });
    await assert.rejects(rollbackMigration(filename, api, confirm("other-run")),
      { code: "T2O_MIGRATION_CONFIRMATION_REQUIRED" });
    assert.deepEqual(deleted, []);
  }));

  it("deletes child-first with durable intent, verifies absence and seals migration resume", () => setup(async (ctx) => {
    const { root, filename, runId, plan, api, sessions, deleted } = ctx;
    const remove = api.deleteSession!;
    api.deleteSession = async (...args) => {
      const durable = await readManifest(filename);
      assert.equal(durable.rollbackState, "in-progress");
      assert.equal(durable.sessions.find((item) => item.targetId === args[0])!.state, "deleting");
      await remove(...args);
    };
    const result = await rollbackMigration(filename, api, confirm(runId));
    assert.equal(result.rolledBack, 2);
    assert.equal(result.rollbackState, "completed");
    assert.equal(result.hasFailures, false);
    assert.deepEqual(deleted, plan.sessions.map((item) => item.targetId).reverse());
    assert.equal(sessions.size, 0);
    assert.equal((await verifyMigration(filename, api)).hasFailures, false);
    assert.equal((await rollbackMigration(filename, api, confirm(runId))).rolledBack, 2);
    assert.equal(deleted.length, 2);
    await assert.rejects(migrate(plan, api, { resumeManifest: filename }), { code: "T2O_MIGRATION_ROLLBACK_STARTED" });
    await assert.rejects(migrate(plan, api, {
      outputDirectory: path.join(root, "replace"), replaceManifest: filename, exclusiveTarget: true,
    }), { code: "T2O_MIGRATION_ROLLBACK_STARTED" });
  }));

  it("protects edits to transcript and native projection fields before deleting any child", () => setup(async (ctx) => {
    const { filename, runId, plan, api, sessions, deleted } = ctx;
    const current = sessions.get(plan.sessions[0].targetId)!;
    const original = structuredClone(current);
    for (const kind of ["text", "timestamp"]) {
      if (kind === "text") current.messages[0].text = "later user message";
      else current.info.time.updated++;
      const report = await rollbackMigration(filename, api, confirm(runId));
      assert.equal(report.hasFailures, true);
      assert.deepEqual(report.sessions[0].codes, ["T2O_MIGRATION_TARGET_CHANGED"]);
      assert.equal(report.rollbackState, "not-started");
      Object.assign(current, structuredClone(original));
    }
    assert.deepEqual(deleted, []);
  }));

  it("protects an external child from native cascading deletion", () => setup(async ({ filename, runId, plan, api, sessions, deleted }) => {
    const foreign = structuredClone(sessions.get(plan.sessions[1].targetId)!);
    foreign.info.id = "ses_external_child";
    sessions.set(foreign.info.id, foreign);
    const report = await rollbackMigration(filename, api, confirm(runId));
    assert.equal(report.hasFailures, true);
    assert.deepEqual(report.sessions[0].codes, ["T2O_MIGRATION_CHILDREN_PROTECTED"]);
    assert.equal(sessions.size, 3);
    assert.deepEqual(deleted, []);
  }));

  it("excludes skipped and replaced sessions from deletion", () => setup(async ({ root, filename, runId, plan, api, sessions, deleted }) => {
    const duplicate = await migrate(plan, api, { outputDirectory: path.join(root, "duplicate") });
    const other = path.join(root, "duplicate", duplicate.manifest);
    assert.equal((await rollbackMigration(other, api, confirm(duplicate.runId))).skipped, 2);
    await edit(filename, (manifest) => {
      for (const item of manifest.sessions) item.replacement = {
        runId: duplicate.runId, deletionHash: item.deletionHash!, state: "deleted",
      };
    });
    const result = await rollbackMigration(filename, api, confirm(runId));
    assert.equal(result.skipped, 2);
    assert.equal(result.rolledBack, 0);
    assert.equal(sessions.size, 2);
    assert.deepEqual(deleted, []);
  }));

  it("recovers ownership of a complete import interrupted before its first readback", () => setup(async ({ filename, runId, api }) => {
    await edit(filename, (manifest) => {
      for (const item of manifest.sessions) {
        item.state = "importing";
        item.created = false;
        delete item.deletionHash;
        delete item.actual;
      }
    });
    const report = await rollbackMigration(filename, api, confirm(runId));
    assert.equal(report.rolledBack, 2);
    assert.equal(report.hasFailures, false);
    assert.ok((await readManifest(filename)).sessions.every((item) => item.deletionHash));
  }));

  it("refuses partial writes without evidence but deletes an unchanged recorded partial write", () => setup(async (ctx) => {
    const { filename, runId, plan, api, sessions, deleted } = ctx;
    sessions.get(plan.sessions[1].targetId)!.messages.pop();
    await edit(filename, (manifest) => {
      const item = manifest.sessions[1];
      item.state = "failed";
      item.created = false;
      delete item.deletionHash;
      delete item.actual;
    });
    const protectedReport = await rollbackMigration(filename, api, confirm(runId));
    assert.equal(protectedReport.hasFailures, true);
    assert.deepEqual(protectedReport.sessions[1].codes, ["T2O_MIGRATION_ROLLBACK_EVIDENCE_MISSING"]);
    assert.deepEqual(deleted, []);
    await edit(filename, (manifest) => {
      const item = manifest.sessions[1];
      item.created = true;
      item.deletionHash = jsonHash(sessions.get(item.targetId));
    });
    assert.equal((await rollbackMigration(filename, api, confirm(runId))).rolledBack, 2);
  }));

  it("protects foreign ownership, missing created sessions and legacy manifests without exact hashes", () => setup(async (ctx) => {
    const { filename, runId, plan, api, sessions, deleted } = ctx;
    const id = plan.sessions[1].targetId;
    const original = sessions.get(id)!;
    sessions.set(id, plan.sessions[1].transfer!);
    assert.equal((await rollbackMigration(filename, api, confirm(runId))).hasFailures, true);
    sessions.delete(id);
    assert.equal((await rollbackMigration(filename, api, confirm(runId))).hasFailures, true);
    sessions.set(id, original);
    await edit(filename, (manifest) => { delete manifest.sessions[1].deletionHash; });
    const result = await rollbackMigration(filename, api, confirm(runId));
    assert.deepEqual(result.sessions[1].codes, ["T2O_MIGRATION_ROLLBACK_EVIDENCE_MISSING"]);
    assert.deepEqual(deleted, []);
  }));

  it("resumes after native deletion succeeded but acknowledgement and readback were lost", () => setup(async (ctx) => {
    const { filename, runId, plan, api, deleted } = ctx;
    const remove = api.deleteSession!;
    const read = api.readSession;
    let unavailable = false;
    api.deleteSession = async (...args) => {
      await remove(...args);
      unavailable = true;
      throw new Trae2OpenCodeError("T2O_OPENCODE_COMMAND_FAILED");
    };
    api.readSession = async (id) => {
      if (unavailable) throw new Trae2OpenCodeError("T2O_OPENCODE_REQUEST_FAILED");
      return read(id);
    };
    await assert.rejects(rollbackMigration(filename, api, confirm(runId)), { code: "T2O_OPENCODE_REQUEST_FAILED" });
    assert.equal((await readManifest(filename)).sessions[1].state, "deleting");
    await assert.rejects(migrate(plan, api, { resumeManifest: filename }), { code: "T2O_MIGRATION_ROLLBACK_STARTED" });
    unavailable = false;
    api.deleteSession = remove;
    assert.equal((await verifyMigration(filename, api)).hasFailures, true);
    assert.equal((await rollbackMigration(filename, api, confirm(runId))).rolledBack, 2);
    assert.equal(deleted.length, 2);
  }));

  it("keeps deletion pending when the native command fails without removing data", () => setup(async ({ filename, runId, api, sessions }) => {
    const remove = api.deleteSession!;
    api.deleteSession = async () => { throw new Trae2OpenCodeError("T2O_OPENCODE_COMMAND_FAILED"); };
    await assert.rejects(rollbackMigration(filename, api, confirm(runId)), { code: "T2O_OPENCODE_COMMAND_FAILED" });
    assert.equal(sessions.size, 2);
    api.deleteSession = remove;
    assert.equal((await rollbackMigration(filename, api, confirm(runId))).rolledBack, 2);
  }));

  it("stops before deletion if a durable checkpoint cannot be written", () => setup(async ({ filename, runId, api, deleted }) => {
    const list = api.listChildren!;
    let count = 0;
    api.listChildren = async (id) => {
      if (++count === 2) {
        await fs.rename(filename, `${filename}.saved`);
        await fs.mkdir(filename);
      }
      return list(id);
    };
    await assert.rejects(rollbackMigration(filename, api, confirm(runId)), { code: "T2O_MIGRATION_CHECKPOINT_FAILED" });
    assert.deepEqual(deleted, []);
  }));

  it("does not claim success when a removed ID is later recreated", () => setup(async ({ filename, runId, plan, api, sessions, deleted }) => {
    await rollbackMigration(filename, api, confirm(runId));
    sessions.set(plan.sessions[0].targetId, plan.sessions[0].transfer!);
    assert.equal((await verifyMigration(filename, api)).hasFailures, true);
    assert.equal((await rollbackMigration(filename, api, confirm(runId))).hasFailures, true);
    assert.equal(deleted.length, 2);
  }));

  it("seals failed imports with no created target and refuses unsupported deletion targets", () => setup(async ({ filename, runId, api, sessions, deleted }) => {
    const remove = api.deleteSession!;
    delete api.deleteSession;
    const unsupported = await rollbackMigration(filename, api, confirm(runId));
    assert.equal(unsupported.hasFailures, true);
    assert.deepEqual(unsupported.sessions[0].codes, ["T2O_OPENCODE_DELETE_UNSUPPORTED"]);
    api.deleteSession = remove;
    sessions.clear();
    await edit(filename, (manifest) => {
      for (const item of manifest.sessions) {
        item.state = "failed";
        item.created = false;
        delete item.deletionHash;
        delete item.actual;
      }
    });
    assert.equal((await rollbackMigration(filename, api, confirm(runId))).rolledBack, 2);
    assert.equal((await verifyMigration(filename, api)).hasFailures, false);
    assert.deepEqual(deleted, []);
  }));
});
