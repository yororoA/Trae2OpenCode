/** Destructive checks run only against a disposable server with synthetic content. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readBundleFile } from "../src/migration/bundle-file.js";
import { migrate, verifyMigration } from "../src/migration/executor.js";
import { readManifest } from "../src/migration/manifest.js";
import { jsonHash } from "../src/migration/ownership.js";
import { buildMigrationPlan } from "../src/migration/plan.js";
import { rollbackMigration } from "../src/migration/rollback.js";
import { createMigrationTarget } from "../src/migration/target.js";
import { Trae2OpenCodeError } from "../src/shared/errors.js";
import { withIsolatedOpenCodeServer } from "../src/target/opencode/isolated-server.js";

await withIsolatedOpenCodeServer({ temporaryRoot: "tmp" }, async (server) => {
  const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
  const child = JSON.parse(JSON.stringify(bundle.sessions[0]).replaceAll("session-synthetic", "session-child"));
  child.parentSourceId = bundle.sessions[0].sourceId;
  bundle.sessions.push(child);
  const plan = await buildMigrationPlan(bundle, { fallbackDirectory: server.directory });
  const target = createMigrationTarget({ ...server, temporaryRoot: server.directory });
  const outputDirectory = path.join(server.directory, "migration");
  const migration = await migrate(plan, target, { outputDirectory });
  assert.equal(migration.verified, 2);
  const filename = path.join(outputDirectory, migration.manifest);
  const options = { confirm: migration.runId, exclusiveTarget: true };
  const before = await fs.readFile(filename, "utf8");
  const preview = await rollbackMigration(filename, target);
  assert.equal(preview.eligible, 2);
  assert.equal(await fs.readFile(filename, "utf8"), before);
  const foreignPlan = await buildMigrationPlan(bundle, { fallbackDirectory: server.directory, namespace: "external" });
  const foreign = foreignPlan.sessions[1].transfer!;
  foreign.info.parentID = plan.sessions[0].targetId;
  const foreignReadback = await target.importSession(foreign);
  const protectedReport = await rollbackMigration(filename, target, options);
  assert.equal(protectedReport.hasFailures, true);
  assert.deepEqual(protectedReport.sessions[0].codes, ["T2O_MIGRATION_CHILDREN_PROTECTED"]);
  assert.ok(await target.readSession(plan.sessions[1].targetId));
  await target.deleteSession(foreign.info.id, jsonHash(foreignReadback), true);

  const nativeDelete = target.deleteSession;
  const nativeRead = target.readSession;
  const deleted: string[] = [];
  let unavailable = false;
  target.deleteSession = async (...args) => {
    const manifest = await readManifest(filename);
    assert.equal(manifest.rollbackState, "in-progress");
    assert.equal(manifest.sessions.find((item) => item.targetId === args[0])!.state, "deleting");
    await nativeDelete(...args);
    deleted.push(args[0]);
    unavailable = true;
    throw new Trae2OpenCodeError("T2O_OPENCODE_COMMAND_FAILED");
  };
  target.readSession = async (id) => {
    if (unavailable) throw new Trae2OpenCodeError("T2O_OPENCODE_REQUEST_FAILED");
    return nativeRead(id);
  };
  await assert.rejects(rollbackMigration(filename, target, options), { code: "T2O_OPENCODE_REQUEST_FAILED" });
  unavailable = false;
  target.deleteSession = async (...args) => { await nativeDelete(...args); deleted.push(args[0]); };
  assert.equal((await verifyMigration(filename, target)).hasFailures, true);
  const resumed = await rollbackMigration(filename, target, options);
  assert.equal(resumed.rolledBack, 2);
  assert.equal(resumed.rollbackState, "completed");
  assert.equal((await verifyMigration(filename, target)).hasFailures, false);
  assert.equal((await rollbackMigration(filename, target, options)).rolledBack, 2);
  assert.deepEqual(deleted, plan.sessions.map((item) => item.targetId).reverse());
  await assert.rejects(migrate(plan, target, { resumeManifest: filename }), { code: "T2O_MIGRATION_ROLLBACK_STARTED" });
  const report = {
    platform: process.platform, version: "2.0.12", source: "synthetic-parser-to-ir-fixture",
    previewEligible: preview.eligible, protectedForeignChildren: 1,
    fault: "native child delete succeeds, acknowledgement and immediate readback fail",
    nativeDeletions: deleted.length, rolledBack: resumed.rolledBack, repeatDeletions: 0,
    verifiedAbsent: true, migrationResumeBlocked: true, status: "verified",
  };
  await fs.writeFile("tmp/m5-5-real-report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
});
