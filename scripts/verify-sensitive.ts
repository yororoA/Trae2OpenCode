import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exportBundleFile, readBundleFile } from "../src/migration/bundle-file.js";
import { migrate, verifyMigration } from "../src/migration/executor.js";
import { buildMigrationPlan } from "../src/migration/plan.js";
import { createMigrationTarget } from "../src/migration/target.js";
import { withIsolatedOpenCodeServer } from "../src/target/opencode/isolated-server.js";

await withIsolatedOpenCodeServer({ temporaryRoot: "tmp" }, async (server) => {
  const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
  const plan = await buildMigrationPlan(bundle, { fallbackDirectory: server.directory });
  const target = createMigrationTarget({ ...server, temporaryRoot: server.directory });
  const secretTransfer = structuredClone(plan.sessions[0].transfer!);
  secretTransfer.messages[0].text = "Authorization: Bearer synthetic-never-valid-token";
  const expected = { code: "T2O_SENSITIVE_CONTENT_REQUIRES_REBINDING" };
  await assert.rejects(target.importSession(secretTransfer), expected);
  assert.equal(await target.readSession(secretTransfer.info.id), null);
  const privateBundle = structuredClone(bundle);
  privateBundle.sessions[0].title = "api_key=synthetic-never-valid-key";
  const exportDirectory = path.join(server.directory, "refused-export");
  await assert.rejects(exportBundleFile(privateBundle, exportDirectory), expected);
  await assert.rejects(fs.stat(exportDirectory), { code: "ENOENT" });
  const outputDirectory = path.join(server.directory, "clean-migration");
  const result = await migrate(plan, target, { outputDirectory });
  assert.equal(result.verified, 1);
  assert.equal((await verifyMigration(path.join(outputDirectory, result.manifest), target)).hasFailures, false);
  const report = {
    platform: process.platform, targetVersion: "2.0.12", source: "synthetic-parser-to-ir-fixture",
    credentialTransferRejected: true, credentialTargetAbsent: true, credentialExportAbsent: true,
    cleanTranscriptVerified: true, status: "verified",
  };
  await fs.writeFile("tmp/m5-6-real-report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
});
