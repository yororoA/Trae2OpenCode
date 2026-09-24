import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import type { OpenCodeTransfer } from "../../target/opencode/mapping.js";
import { readBundleFile } from "../bundle-file.js";
import { migrate } from "../executor.js";
import { readManifest, withManifestStore } from "../manifest.js";
import { jsonHash } from "../ownership.js";
import { buildMigrationPlan } from "../plan.js";
import type { MigrationTarget } from "../target.js";

async function setup(operation: (ctx: {
  root: string; plan: Awaited<ReturnType<typeof buildMigrationPlan>>; previous: string;
  api: MigrationTarget; sessions: Map<string, OpenCodeTransfer>; deleted: string[];
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-replacement-"));
  try {
    const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
    const child = JSON.parse(JSON.stringify(bundle.sessions[0]).replaceAll("session-synthetic", "session-child"));
    child.parentSourceId = bundle.sessions[0].sourceId;
    bundle.sessions.push(child);
    const plan = await buildMigrationPlan(bundle, { fallbackDirectory: root });
    assert.ok(plan.sessions.every((item) => item.status === "ready"));
    const hash = jsonHash("target");
    const sessions = new Map<string, OpenCodeTransfer>();
    const deleted: string[] = [];
    const api: MigrationTarget = {
      async describe() {
        return { endpointHash: hash, fingerprint: hash, schemaHash: hash, binaryVersion: "2.0.12", serverVersion: "2.0.12" };
      },
      async readSession(id) { return structuredClone(sessions.get(id) ?? null); },
      async importSession(transfer) {
        assert.ok(!sessions.has(transfer.info.id));
        if (transfer.info.parentID) assert.ok(sessions.has(transfer.info.parentID as string));
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
    const first = path.join(root, "first");
    assert.equal((await migrate(plan, api, { outputDirectory: first })).verified, 2);
    await operation({ root, plan, api, sessions, deleted, previous: path.join(first, "migration-manifest.json") });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

describe("explicit tool-owned replacement", () => {
  it("checkpoints child-first deletion, imports parent-first and distinguishes replacements", () => setup(async (ctx) => {
    const { root, plan, api, previous, deleted } = ctx;
    const filename = path.join(root, "second", "migration-manifest.json");
    const remove = api.deleteSession!;
    api.deleteSession = async (id, hash, exclusive) => {
      const durable = await readManifest(filename);
      assert.equal(durable.sessions.find((item) => item.targetId === id)!.replacement!.state, "deleting");
      return remove(id, hash, exclusive);
    };
    plan.sessions[0].transfer!.info.title = "Updated source title";
    const result = await migrate(plan, api, {
      outputDirectory: path.dirname(filename), replaceManifest: previous, exclusiveTarget: true,
    });
    assert.deepEqual(deleted, plan.sessions.map((item) => item.targetId).reverse());
    assert.equal(result.verified, 2);
    assert.equal(result.created, 0);
    assert.equal(result.replaced, 2);
    const resumed = await migrate(plan, api, { resumeManifest: filename });
    assert.equal(resumed.verified, 2);
    assert.equal(deleted.length, 2);
    assert.notEqual(result.runId, (await readManifest(previous)).runId);
  }));

  it("rebinds an unchanged previous run before authorizing replacement", () => setup(async (ctx) => {
    const { root, plan, api, previous, deleted } = ctx;
    const nextHash = jsonHash("next-endpoint");
    api.describe = async () => ({
      endpointHash: nextHash,
      fingerprint: jsonHash("next-fingerprint"),
      schemaHash: jsonHash("target"),
      binaryVersion: "2.0.12",
      serverVersion: "2.0.16",
    });
    plan.sessions[0].transfer!.info.title = "Updated after service restart";
    const result = await migrate(plan, api, {
      outputDirectory: path.join(root, "second"),
      replaceManifest: previous,
      exclusiveTarget: true,
    });
    assert.equal(result.verified, 2);
    assert.equal(result.replaced, 2);
    assert.equal((await readManifest(previous)).target.endpointHash, nextHash);
    assert.deepEqual(deleted, plan.sessions.map((item) => item.targetId).reverse());
  }));

  it("requires explicit exclusive use before reading a target", () => setup(async ({ root, plan, api, previous, deleted }) => {
    api.describe = async () => { assert.fail("No reads before acknowledgement"); };
    await assert.rejects(migrate(plan, api, { outputDirectory: path.join(root, "second"), replaceManifest: previous }),
      { code: "T2O_MIGRATION_EXCLUSIVE_REQUIRED" });
    assert.equal(deleted.length, 0);
  }));

  it("refuses target edits even in fields ignored by import reconciliation", () => setup(async ({ root, plan, api, sessions, previous, deleted }) => {
    const actual = sessions.get(plan.sessions[0].targetId)!;
    actual.info.time.updated++;
    await assert.rejects(migrate(plan, api, {
      outputDirectory: path.join(root, "second"), replaceManifest: previous, exclusiveTarget: true,
    }), { code: "T2O_MIGRATION_TARGET_CHANGED" });
    assert.equal(deleted.length, 0);
    assert.equal(sessions.size, 2);
  }));

  it("continues replacement when every old target is already absent", () => setup(async ({ root, plan, api, sessions, previous, deleted }) => {
    sessions.clear();
    plan.sessions[0].transfer!.info.title = "Updated after external removal";
    const result = await migrate(plan, api, {
      outputDirectory: path.join(root, "second"),
      replaceManifest: previous,
      exclusiveTarget: true,
    });
    assert.equal(result.verified, 2);
    assert.equal(result.replaced, 2);
    assert.equal(deleted.length, 0);
    assert.equal(sessions.size, 2);
  }));

  it("protects foreign children and rejects a partial selection of a parent tree", () => setup(async ({ root, plan, api, sessions, previous, deleted }) => {
    const unrelated = structuredClone(sessions.get(plan.sessions[1].targetId)!);
    unrelated.info.id = "ses_later_child";
    sessions.set(unrelated.info.id, unrelated);
    await assert.rejects(migrate(plan, api, {
      outputDirectory: path.join(root, "second"), replaceManifest: previous, exclusiveTarget: true,
    }), { code: "T2O_MIGRATION_CHILDREN_PROTECTED" });
    sessions.delete(unrelated.info.id);
    const partial = structuredClone(plan);
    partial.sessions.pop();
    await assert.rejects(migrate(partial, api, {
      outputDirectory: path.join(root, "third"), replaceManifest: previous, exclusiveTarget: true,
    }), { code: "T2O_MIGRATION_CHILDREN_PROTECTED" });
    assert.equal(deleted.length, 0);
  }));

  it("refuses missing old evidence, skipped foreign sessions and parent changes", () => setup(async ({ root, plan, api, previous, deleted }) => {
    const original = await readManifest(previous);
    for (const kind of ["missing-hash", "skipped", "parent"] as const) {
      await withManifestStore(previous, async (store) => {
        const value = structuredClone(original);
        if (kind === "missing-hash") delete value.sessions[0].deletionHash;
        if (kind === "skipped") value.sessions[0].state = "skipped";
        if (kind === "parent") delete value.sessions[1].parentId;
        await store.save(value);
      });
      await assert.rejects(migrate(plan, api, {
        outputDirectory: path.join(root, kind), replaceManifest: previous, exclusiveTarget: true,
      }), { code: "T2O_MIGRATION_REPLACEMENT_INVALID" });
    }
    assert.equal(deleted.length, 0);
  }));

  it("resumes after deletion succeeded but both acknowledgement and readback were lost", () => setup(async ({ root, plan, api, previous, deleted }) => {
    const outputDirectory = path.join(root, "second");
    const filename = path.join(outputDirectory, "migration-manifest.json");
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
    await assert.rejects(migrate(plan, api, { outputDirectory, replaceManifest: previous, exclusiveTarget: true }),
      { code: "T2O_OPENCODE_REQUEST_FAILED" });
    assert.equal((await readManifest(filename)).sessions[1].replacement!.state, "deleting");
    unavailable = false;
    api.deleteSession = remove;
    await assert.rejects(migrate(plan, api, { resumeManifest: filename }), { code: "T2O_MIGRATION_EXCLUSIVE_REQUIRED" });
    const resumed = await migrate(plan, api, { resumeManifest: filename, exclusiveTarget: true });
    assert.equal(resumed.replaced, 2);
    assert.equal(resumed.verified, 2);
    assert.equal(deleted.length, 2);
  }));

  it("stops before a native delete when its checkpoint fails", () => setup(async ({ root, plan, api, previous, deleted }) => {
    const outputDirectory = path.join(root, "second");
    const filename = path.join(outputDirectory, "migration-manifest.json");
    const list = api.listChildren!;
    let queries = 0;
    api.listChildren = async (id) => {
      if (++queries === 2) {
        await fs.rename(filename, `${filename}.saved`);
        await fs.mkdir(filename);
      }
      return list(id);
    };
    await assert.rejects(migrate(plan, api, { outputDirectory, replaceManifest: previous, exclusiveTarget: true }),
      { code: "T2O_MIGRATION_CHECKPOINT_FAILED" });
    assert.equal(deleted.length, 0);
  }));

  it("resumes imports after old sessions were deleted without deleting again", () => setup(async ({ root, plan, api, previous, deleted }) => {
    const outputDirectory = path.join(root, "second");
    const nativeImport = api.importSession;
    api.importSession = async () => { throw new Trae2OpenCodeError("T2O_OPENCODE_IMPORT_FAILED"); };
    const failed = await migrate(plan, api, { outputDirectory, replaceManifest: previous, exclusiveTarget: true });
    assert.equal(failed.hasFailures, true);
    assert.equal(deleted.length, 2);
    api.importSession = nativeImport;
    const result = await migrate(plan, api, { resumeManifest: path.join(outputDirectory, "migration-manifest.json") });
    assert.equal(result.verified, 2);
    assert.equal(deleted.length, 2);
  }));
});
