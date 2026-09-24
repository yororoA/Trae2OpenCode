/** Native destructive behavior is tested only in this disposable synthetic server. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readBundleFile } from "../src/migration/bundle-file.js";
import { migrate, verifyMigration } from "../src/migration/executor.js";
import { readManifest } from "../src/migration/manifest.js";
import { jsonHash } from "../src/migration/ownership.js";
import { buildMigrationPlan } from "../src/migration/plan.js";
import { createMigrationTarget } from "../src/migration/target.js";
import { Trae2OpenCodeError } from "../src/shared/errors.js";
import { withIsolatedOpenCodeServer } from "../src/target/opencode/isolated-server.js";

const binary = process.env.T2O_TEST_OPENCODE_BINARY;
await withIsolatedOpenCodeServer({
  temporaryRoot: "tmp",
  ...(binary ? { binary: path.resolve(binary) } : {}),
}, async (server) => {
  const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
  const child = JSON.parse(JSON.stringify(bundle.sessions[0]).replaceAll("session-synthetic", "session-child"));
  child.parentSourceId = bundle.sessions[0].sourceId;
  bundle.sessions.push(child);
  const plan = await buildMigrationPlan(bundle, { fallbackDirectory: server.directory });
  const target = createMigrationTarget({ ...server, temporaryRoot: server.directory });
  const descriptor = await target.describe();
  const first = path.join(server.directory, "first");
  const previous = path.join(first, "migration-manifest.json");
  assert.equal((await migrate(plan, target, { outputDirectory: first })).verified, 2);
  const duplicate = await migrate(plan, target, { outputDirectory: path.join(server.directory, "duplicate") });
  assert.equal(duplicate.skipped, 2);
  assert.equal(duplicate.hasFailures, false);

  const foreignPlan = await buildMigrationPlan(bundle, { fallbackDirectory: server.directory, namespace: "foreign" });
  const foreign = foreignPlan.sessions[1].transfer!;
  foreign.info.parentID = plan.sessions[0].targetId;
  const foreignReadback = await target.importSession(foreign);
  await assert.rejects(migrate(plan, target, {
    outputDirectory: path.join(server.directory, "protected"), replaceManifest: previous, exclusiveTarget: true,
  }), { code: "T2O_MIGRATION_CHILDREN_PROTECTED" });
  assert.ok(await target.readSession(foreign.info.id));
  await target.deleteSession(foreign.info.id, jsonHash(foreignReadback), true);

  const updated = structuredClone(plan);
  updated.sessions[0].transfer!.info.title = "Updated synthetic source";
  const replacementDirectory = path.join(server.directory, "replacement");
  const filename = path.join(replacementDirectory, "migration-manifest.json");
  const nativeDelete = target.deleteSession;
  const nativeRead = target.readSession;
  const deleted: string[] = [];
  let unavailable = false;
  target.deleteSession = async (id, hash, exclusive) => {
    assert.equal((await readManifest(filename)).sessions.find((item) => item.targetId === id)!.replacement!.state, "deleting");
    await nativeDelete(id, hash, exclusive);
    deleted.push(id);
    unavailable = true;
    throw new Trae2OpenCodeError("T2O_OPENCODE_COMMAND_FAILED");
  };
  target.readSession = async (id) => {
    if (unavailable) throw new Trae2OpenCodeError("T2O_OPENCODE_REQUEST_FAILED");
    return nativeRead(id);
  };
  await assert.rejects(migrate(updated, target, {
    outputDirectory: replacementDirectory, replaceManifest: previous, exclusiveTarget: true,
  }), { code: "T2O_OPENCODE_REQUEST_FAILED" });
  unavailable = false;
  target.deleteSession = async (...args) => { await nativeDelete(...args); deleted.push(args[0]); };
  const resumed = await migrate(updated, target, { resumeManifest: filename, exclusiveTarget: true });
  assert.equal(resumed.replaced, 2);
  assert.equal(resumed.created, 0);
  assert.equal(resumed.verified, 2);
  assert.deepEqual(deleted, plan.sessions.map((item) => item.targetId).reverse());
  assert.equal((await verifyMigration(filename, target)).hasFailures, false);
  assert.equal((await nativeRead(plan.sessions[0].targetId))!.info.title, "Updated synthetic source");
  const report = {
    platform: process.platform,
    binaryVersion: descriptor.binaryVersion,
    serverVersion: descriptor.serverVersion,
    source: "synthetic-parser-to-ir-fixture",
    duplicateSkipped: duplicate.skipped, protectedForeignChildren: 1,
    fault: "native child delete succeeds, acknowledgement and immediate readback fail",
    deleted: deleted.length, replaced: resumed.replaced, newlyCreated: resumed.created,
    verified: resumed.verified, status: "verified",
  };
  await fs.writeFile("tmp/m5-4-real-report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
});
