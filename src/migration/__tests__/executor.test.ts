import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonObject } from "../../ir/types.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import type { OpenCodeTransfer } from "../../target/opencode/mapping.js";
import { readBundleFile } from "../bundle-file.js";
import { migrate, verifyMigration } from "../executor.js";
import { readManifest, withManifestStore } from "../manifest.js";
import { buildMigrationPlan } from "../plan.js";
import type { MigrationTarget, MigrationTargetDescriptor } from "../target.js";

const hash = hashCanonicalJson("synthetic-target");
const descriptor: MigrationTargetDescriptor = {
  endpointHash: hash, binaryVersion: "2.0.12", serverVersion: "2.0.12", schemaHash: hash, fingerprint: hash,
};
function target() {
  const sessions = new Map<string, OpenCodeTransfer>();
  const imports: string[] = [];
  const api: MigrationTarget = {
    async describe() { return structuredClone(descriptor); },
    async readSession(id) { return structuredClone(sessions.get(id) ?? null); },
    async importSession(transfer) {
      assert.ok(!sessions.has(transfer.info.id), "Import must never overwrite a session");
      imports.push(transfer.info.id);
      sessions.set(transfer.info.id, structuredClone(transfer));
      return structuredClone(transfer);
    },
  };
  return { api, sessions, imports };
}
async function setup(operation: (context: {
  outputDirectory: string; filename: string;
  plan: Awaited<ReturnType<typeof buildMigrationPlan>>;
  fake: ReturnType<typeof target>;
}) => Promise<void>, multiple = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-executor-"));
  try {
    const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
    if (multiple) {
      bundle.sessions.push(JSON.parse(JSON.stringify(bundle.sessions[0]).replaceAll("session-synthetic", "session-two")));
    }
    const plan = await buildMigrationPlan(bundle, { fallbackDirectory: root });
    assert.ok(plan.sessions.every((item) => item.status === "ready"));
    const outputDirectory = path.join(root, "output");
    await operation({ outputDirectory, filename: path.join(outputDirectory, "migration-manifest.json"), plan, fake: target() });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

describe("migration executor", () => {
  it("rejects modified plans containing credentials before reading target or creating output", () => setup(async ({ plan, fake, outputDirectory }) => {
    plan.sessions[0].transfer!.messages[0].text = "Authorization: Bearer synthetic-token-value";
    fake.api.describe = async () => assert.fail("No target calls allowed");
    await assert.rejects(migrate(plan, fake.api, { outputDirectory }),
      { code: "T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING" });
    await assert.rejects(fs.stat(outputDirectory), { code: "ENOENT" });
    assert.equal(fake.imports.length, 0);
  }));

  it("persists intent before import, verifies content, and resumes without a second import", () => setup(async (ctx) => {
    const { plan, fake, filename, outputDirectory } = ctx;
    const nativeImport = fake.api.importSession;
    fake.api.importSession = async (transfer) => {
      const manifest = await readManifest(filename);
      assert.equal(manifest.sessions[0].state, "importing");
      assert.equal(manifest.sessions[0].attempts, 1);
      assert.equal(manifest.sessions[0].created, false);
      assert.ok(manifest.sessions[0].expected);
      return nativeImport(transfer);
    };
    const result = await migrate(plan, fake.api, { outputDirectory });
    assert.equal(result.verified, 1);
    assert.equal(result.created, 1);
    assert.equal(result.hasFailures, false);
    assert.equal((await verifyMigration(filename, fake.api)).hasFailures, false);
    const resumed = await migrate(plan, fake.api, { resumeManifest: filename });
    assert.equal(resumed.verified, 1);
    assert.equal(fake.imports.length, 1);
    const content = await fs.readFile(filename, "utf8");
    assert.doesNotMatch(content, /Read this file|First persisted|sourceSessionSha256|fallbackDirectory/);
    assert.ok(!content.includes(path.dirname(outputDirectory)));
  }));

  it("recovers a write whose acknowledgement and first readback were lost", () => setup(async ({ plan, fake, filename, outputDirectory }) => {
    const nativeImport = fake.api.importSession;
    const nativeRead = fake.api.readSession;
    let unavailable = false;
    fake.api.importSession = async (transfer) => {
      await nativeImport(transfer);
      unavailable = true;
      throw new Trae2OpenCodeError("T2O_OPENCODE_COMMAND_FAILED");
    };
    fake.api.readSession = async (id) => {
      if (unavailable) throw new Trae2OpenCodeError("T2O_OPENCODE_REQUEST_FAILED");
      return nativeRead(id);
    };
    const first = await migrate(plan, fake.api, { outputDirectory });
    assert.equal(first.hasFailures, true);
    assert.equal(first.created, 0);
    assert.equal((await readManifest(filename)).sessions[0].attempts, 1);
    unavailable = false;
    const resumed = await migrate(plan, fake.api, { resumeManifest: filename });
    assert.equal(resumed.verified, 1);
    assert.equal(resumed.created, 1);
    assert.equal(fake.imports.length, 1);
  }));

  it("records partial target writes without overwriting them and isolates other sessions", () => setup(async ({ plan, fake, filename, outputDirectory }) => {
    const nativeImport = fake.api.importSession;
    fake.api.importSession = async (transfer) => {
      if (transfer.info.id === plan.sessions[0].targetId) {
        const partial = structuredClone(transfer);
        partial.messages.pop();
        return nativeImport(partial);
      }
      return nativeImport(transfer);
    };
    const first = await migrate(plan, fake.api, { outputDirectory });
    assert.equal(first.created, 2);
    assert.equal(first.verified, 1);
    assert.equal(first.hasFailures, true);
    assert.ok(first.sessions[0].codes.includes("T2O_MIGRATION_PARTIAL_WRITE"));
    assert.equal((await verifyMigration(filename, fake.api)).hasFailures, true);
    assert.equal((await migrate(plan, fake.api, { resumeManifest: filename })).verified, 1);
    assert.equal(fake.imports.length, 2);
  }, true));

  it("retries a failed import only when no session was created", () => setup(async ({ plan, fake, filename, outputDirectory }) => {
    const nativeImport = fake.api.importSession;
    fake.api.importSession = async () => { throw new Trae2OpenCodeError("T2O_OPENCODE_IMPORT_FAILED"); };
    assert.equal((await migrate(plan, fake.api, { outputDirectory })).hasFailures, true);
    fake.api.importSession = nativeImport;
    const result = await migrate(plan, fake.api, { resumeManifest: filename });
    assert.equal(result.verified, 1);
    assert.equal(result.sessions[0].attempts, 2);
  }));

  it("does not claim a foreign session, including a concurrent creator after preflight", () => setup(async ({ plan, fake, filename, outputDirectory }) => {
    fake.api.importSession = async (transfer) => {
      const foreign = structuredClone(transfer);
      delete ((foreign.info.metadata as JsonObject).trae2opencode as JsonObject).migrationRunId;
      fake.sessions.set(transfer.info.id, foreign);
      throw new Trae2OpenCodeError("T2O_OPENCODE_SESSION_CONFLICT");
    };
    const first = await migrate(plan, fake.api, { outputDirectory });
    assert.equal(first.hasFailures, true);
    assert.equal(first.created, 0);
    assert.equal((await migrate(plan, fake.api, { resumeManifest: filename })).created, 0);
    assert.deepEqual((await readManifest(filename)).sessions[0].codes, ["T2O_MIGRATION_TARGET_CHANGED"]);
  }));

  it("rebinds a compatible endpoint and version change after exact target proof", () => setup(async ({ plan, fake, filename, outputDirectory }) => {
    await migrate(plan, fake.api, { outputDirectory });
    const reboundDescriptor = {
      ...descriptor,
      endpointHash: hashCanonicalJson("other-endpoint"),
      serverVersion: "2.0.16",
      fingerprint: hashCanonicalJson("other-fingerprint"),
    };
    fake.api.describe = async () => structuredClone(reboundDescriptor);
    const resumed = await migrate(plan, fake.api, { resumeManifest: filename });
    assert.equal(resumed.verified, 1);
    assert.equal(fake.imports.length, 1);
    assert.deepEqual((await readManifest(filename)).target, reboundDescriptor);
    assert.equal((await verifyMigration(filename, fake.api)).hasFailures, false);
  }));

  it("rejects a changed source plan, target contract, or edited successful target", () => setup(async ({ plan, fake, filename, outputDirectory }) => {
    await migrate(plan, fake.api, { outputDirectory });
    const changed = structuredClone(plan);
    changed.irHash = hashCanonicalJson("changed");
    await assert.rejects(migrate(changed, fake.api, { resumeManifest: filename }), { code: "T2O_MIGRATION_PLAN_CHANGED" });
    fake.api.describe = async () => ({
      ...descriptor,
      schemaHash: hashCanonicalJson("other-schema"),
      fingerprint: hashCanonicalJson("other-contract"),
    });
    await assert.rejects(migrate(plan, fake.api, { resumeManifest: filename }), { code: "T2O_MIGRATION_TARGET_CHANGED" });
    await assert.rejects(verifyMigration(filename, fake.api), { code: "T2O_MIGRATION_TARGET_CHANGED" });
    fake.api.describe = async () => structuredClone(descriptor);
    fake.sessions.get(plan.sessions[0].targetId)!.messages[0].text = "new user content";
    await assert.rejects(migrate(plan, fake.api, { resumeManifest: filename }), { code: "T2O_MIGRATION_TARGET_CHANGED" });
    assert.equal((await verifyMigration(filename, fake.api)).hasFailures, true);
    assert.equal(fake.imports.length, 1);
  }));

  it("rebinds an empty compatible target when no planned ID exists", () => setup(async ({ plan, fake, filename, outputDirectory }) => {
    const nativeImport = fake.api.importSession;
    fake.api.importSession = async () => {
      throw new Trae2OpenCodeError("T2O_OPENCODE_IMPORT_FAILED");
    };
    assert.equal((await migrate(plan, fake.api, { outputDirectory })).hasFailures, true);
    fake.api.describe = async () => ({
      ...descriptor,
      endpointHash: hashCanonicalJson("other-endpoint"),
      fingerprint: hashCanonicalJson("other-fingerprint"),
    });
    fake.api.importSession = nativeImport;
    const result = await migrate(plan, fake.api, { resumeManifest: filename });
    assert.equal(result.verified, 1);
    assert.equal(result.sessions[0].attempts, 2);
  }));

  it("rejects compatible rebinding when a planned ID exists without valid evidence", () => setup(async ({ plan, fake, filename, outputDirectory }) => {
    fake.api.importSession = async () => {
      throw new Trae2OpenCodeError("T2O_OPENCODE_IMPORT_FAILED");
    };
    assert.equal((await migrate(plan, fake.api, { outputDirectory })).hasFailures, true);
    fake.sessions.set(plan.sessions[0].targetId, structuredClone(plan.sessions[0].transfer!));
    fake.api.describe = async () => ({
      ...descriptor,
      endpointHash: hashCanonicalJson("other-endpoint"),
      fingerprint: hashCanonicalJson("other-fingerprint"),
    });
    await assert.rejects(
      migrate(plan, fake.api, { resumeManifest: filename }),
      { code: "T2O_MIGRATION_TARGET_CHANGED" },
    );
  }));

  it("stops all writes when the importing checkpoint cannot be saved", () => setup(async ({ plan, fake, filename, outputDirectory }) => {
    fake.api.readSession = async () => {
      await fs.rename(filename, `${filename}.saved`);
      await fs.mkdir(filename);
      return null;
    };
    await assert.rejects(migrate(plan, fake.api, { outputDirectory }), { code: "T2O_MIGRATION_CHECKPOINT_FAILED" });
    assert.equal(fake.imports.length, 0);
    const durable = await readManifest(`${filename}.saved`);
    assert.ok(durable.sessions.every((item) => item.attempts === 0));
  }, true));

  it("recovers a durable importing checkpoint without re-importing", () => setup(async ({ plan, fake, filename, outputDirectory }) => {
    await migrate(plan, fake.api, { outputDirectory });
    await withManifestStore(filename, async (store) => {
      const manifest = await store.read();
      manifest.sessions[0].state = "importing";
      manifest.sessions[0].created = false;
      delete manifest.sessions[0].actual;
      delete manifest.sessions[0].deletionHash;
      await store.save(manifest);
    });
    const recovered = await migrate(plan, fake.api, { resumeManifest: filename });
    assert.equal(recovered.created, 1);
    assert.equal(recovered.verified, 1);
    assert.equal(fake.imports.length, 1);
  }));

  it("recreates a verified tool-owned session that is now absent", () => setup(async ({ plan, fake, filename, outputDirectory }) => {
    assert.equal((await migrate(plan, fake.api, { outputDirectory })).verified, 1);
    fake.sessions.delete(plan.sessions[0].targetId);
    const restored = await migrate(plan, fake.api, { resumeManifest: filename });
    assert.equal(restored.verified, 1);
    assert.equal(restored.created, 1);
    assert.equal(restored.sessions[0].attempts, 2);
    assert.equal(fake.imports.length, 2);
    assert.ok(fake.sessions.has(plan.sessions[0].targetId));
  }));

  it("skips pre-existing sessions and rejects an existing output directory", () => setup(async ({ plan, fake, outputDirectory }) => {
    fake.sessions.set(plan.sessions[0].targetId, plan.sessions[0].transfer!);
    const result = await migrate(plan, fake.api, { outputDirectory });
    assert.equal(result.skipped, 1);
    assert.equal(result.created, 0);
    assert.equal(fake.imports.length, 0);
    await assert.rejects(migrate(plan, fake.api, { outputDirectory }), { code: "T2O_MIGRATION_CHECKPOINT_FAILED" });
  }));

  it("skips an entire existing parent graph without claiming a missing parent", () => setup(async ({ plan, fake, outputDirectory }) => {
    plan.sessions[1].parentId = plan.sessions[0].targetId;
    plan.sessions[1].transfer!.info.parentID = plan.sessions[0].targetId;
    for (const item of plan.sessions) fake.sessions.set(item.targetId, item.transfer!);
    const result = await migrate(plan, fake.api, { outputDirectory });
    assert.equal(result.skipped, 2);
    assert.equal(result.hasFailures, false);
    assert.equal(fake.imports.length, 0);
  }, true));

  it("does not attach a new child to a skipped foreign parent", () => setup(async ({ plan, fake, outputDirectory }) => {
    plan.sessions[1].parentId = plan.sessions[0].targetId;
    plan.sessions[1].transfer!.info.parentID = plan.sessions[0].targetId;
    fake.sessions.set(plan.sessions[0].targetId, plan.sessions[0].transfer!);
    const result = await migrate(plan, fake.api, { outputDirectory });
    assert.equal(result.skipped, 1);
    assert.equal(result.hasFailures, true);
    assert.deepEqual(result.sessions[1].codes, ["T2O_OPENCODE_PARENT_MISSING"]);
    assert.equal(fake.imports.length, 0);
  }, true));

  it("keeps the first partial readback hash when the target is subsequently edited", () => setup(async ({ plan, fake, filename, outputDirectory }) => {
    const nativeImport = fake.api.importSession;
    fake.api.importSession = async (transfer) => {
      const partial = structuredClone(transfer);
      partial.messages.pop();
      return nativeImport(partial);
    };
    const first = await migrate(plan, fake.api, { outputDirectory });
    const originalHash = first.sessions[0].deletionHash;
    assert.ok(originalHash);
    fake.sessions.get(plan.sessions[0].targetId)!.messages[0].text = "later edit";
    const resumed = await migrate(plan, fake.api, { resumeManifest: filename });
    assert.equal(resumed.sessions[0].deletionHash, originalHash);
    assert.deepEqual(resumed.sessions[0].codes, ["T2O_MIGRATION_TARGET_CHANGED"]);
    assert.equal(fake.imports.length, 1);
  }));
});
