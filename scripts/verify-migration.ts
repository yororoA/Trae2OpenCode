/** Synthetic migration against a disposable real OpenCode server; no user data. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readBundleFile } from "../src/migration/bundle-file.js";
import { migrate, verifyMigration } from "../src/migration/executor.js";
import { readManifest } from "../src/migration/manifest.js";
import { buildMigrationPlan } from "../src/migration/plan.js";
import { createMigrationTarget } from "../src/migration/target.js";
import { Trae2OpenCodeError } from "../src/shared/errors.js";
import { withIsolatedOpenCodeServer } from "../src/target/opencode/isolated-server.js";

await withIsolatedOpenCodeServer({ temporaryRoot: "tmp" }, async (server) => {
  const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
  const plan = await buildMigrationPlan(bundle, { fallbackDirectory: server.directory });
  const target = createMigrationTarget({ ...server, temporaryRoot: server.directory });
  const outputDirectory = path.join(server.directory, "migration");
  const filename = path.join(outputDirectory, "migration-manifest.json");
  const nativeImport = target.importSession;
  const nativeRead = target.readSession;
  let readUnavailable = false;
  let imports = 0;
  target.importSession = async (transfer) => {
    imports++;
    const durable = await readManifest(filename);
    assert.equal(durable.sessions[0].state, "importing");
    await nativeImport(transfer);
    readUnavailable = true;
    throw new Trae2OpenCodeError("T2O_OPENCODE_COMMAND_FAILED");
  };
  target.readSession = async (id) => {
    if (readUnavailable) throw new Trae2OpenCodeError("T2O_OPENCODE_REQUEST_FAILED");
    return nativeRead(id);
  };
  const interrupted = await migrate(plan, target, { outputDirectory });
  assert.equal(interrupted.hasFailures, true);
  assert.equal(interrupted.created, 0);
  readUnavailable = false;
  const resumed = await migrate(plan, target, { resumeManifest: filename });
  assert.equal(resumed.verified, 1);
  assert.equal(resumed.created, 1);
  assert.equal(resumed.hasFailures, false);
  assert.equal(imports, 1);
  const verification = await verifyMigration(filename, target);
  assert.equal(verification.hasFailures, false);
  const duplicate = await migrate(plan, target, { outputDirectory: path.join(server.directory, "second-run") });
  assert.equal(duplicate.skipped, 1);
  assert.equal(duplicate.created, 0);
  assert.equal(imports, 1);
  const actual = await nativeRead(plan.sessions[0].targetId);
  assert.ok(actual);
  const report = {
    platform: process.platform, version: "2.0.12", source: "synthetic-parser-to-ir-fixture",
    fault: "native import succeeds, acknowledgement and immediate readback fail",
    imports, resumed: resumed.verified, duplicateSkipped: duplicate.skipped,
    counts: verification.sessions[0].actual?.counts,
    manifestContainsTranscript: (await fs.readFile(filename, "utf8")).includes("First persisted"),
    status: "verified",
  };
  assert.equal(report.manifestContainsTranscript, false);
  await fs.writeFile("tmp/m5-3-real-report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
});
