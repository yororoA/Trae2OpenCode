/** Explicit real TRAE source; target data is disposable and always isolated. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { loadCommandBundle } from "../src/cli/commands.js";
import { hashCanonicalJson } from "../src/ir/canonical.js";
import { exportBundleFile, readBundleFile } from "../src/migration/bundle-file.js";
import { migrate, verifyMigration } from "../src/migration/executor.js";
import { buildMigrationPlan } from "../src/migration/plan.js";
import { createMigrationTarget } from "../src/migration/target.js";
import { normalizeError, Trae2OpenCodeError } from "../src/shared/errors.js";
import { assertNoCredentials } from "../src/shared/sensitive.js";
import { withIsolatedOpenCodeServer } from "../src/target/opencode/isolated-server.js";

async function main() {
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      options: {
        cdp: { type: "string" }, "cdp-target": { type: "string" },
        session: { type: "string" }, "trae-root": { type: "string" },
        "product-file": { type: "string" },
      },
    }).values;
  } catch { throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS"); }
  if (!values.cdp || !values.session) throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");

  // No input/fixture bypass: this goes through the same CDP reader as the CLI.
  const bundle = await loadCommandBundle({
    cdp: values.cdp, cdpTarget: values["cdp-target"], session: values.session,
    traeRoot: values["trae-root"], productFile: values["product-file"],
  });
  assert.equal(bundle.sessions.length, 1, "Select one representative session");
  const session = bundle.sessions[0];
  assert.ok(["complete", "partial"].includes(session.recovery),
    "A recoverable real session is required for acceptance");
  assert.ok(session.events.some((event) => event.type === "user"), "User content is required");
  const content = session.events.flatMap((event) => event.type === "assistant" ? event.content : []);
  for (const type of ["text", "tool"]) {
    assert.ok(content.some((block) => block.type === type), `Representative ${type} content is required`);
  }

  const binary = process.env.T2O_TEST_OPENCODE_BINARY;
  await withIsolatedOpenCodeServer({
    temporaryRoot: "tmp", ...(binary ? { binary: path.resolve(binary) } : {}),
  }, async (server) => {
    const output = path.join(server.directory, "source-export");
    const exported = await exportBundleFile(bundle, output);
    const diskBundle = await readBundleFile(path.join(output, exported.filename));
    // Explicit mapping keeps the project context in the disposable directory too.
    const pathMaps = session.projectPath ? [{ from: session.projectPath, to: server.directory }] : [];
    const plan = await buildMigrationPlan(diskBundle, {
      fallbackDirectory: server.directory, pathMaps,
    });
    assert.equal(plan.sessions.length, 1);
    assert.equal(plan.sessions[0].status, "ready", "The real session must pass production mapping gates");
    assert.equal(plan.sessions[0].expected?.counts.messages, session.events.length);
    const target = createMigrationTarget({ ...server, temporaryRoot: server.directory });
    const nativeImport = target.importSession;
    let imports = 0;
    target.importSession = async (transfer) => { imports++; return nativeImport(transfer); };
    const outputDirectory = path.join(server.directory, "migration");
    const migrated = await migrate(plan, target, { outputDirectory });
    assert.equal(migrated.hasFailures, false);
    assert.equal(migrated.created, 1);
    assert.equal(migrated.verified, 1);
    const manifest = path.join(outputDirectory, "migration-manifest.json");
    const verification = await verifyMigration(manifest, target);
    assert.equal(verification.hasFailures, false);
    const resumed = await migrate(plan, target, { resumeManifest: manifest });
    assert.equal(resumed.hasFailures, false);
    assert.equal(resumed.verified, 1);
    const duplicate = await migrate(plan, target, { outputDirectory: path.join(server.directory, "duplicate") });
    assert.equal(duplicate.created, 0);
    assert.equal(duplicate.skipped, 1);
    assert.equal(imports, 1);
    const report = {
      reportVersion: 1, status: "verified", capturedAt: new Date().toISOString(),
      source: "real-trae-production-cdp", sourceVersion: bundle.source.product.version,
      sourceSessionHash: hashCanonicalJson(session.sourceId), irHash: exported.irHash,
      recovery: session.recovery, platform: process.platform, node: process.version,
      targetVersion: migrated.target.binaryVersion, imports, duplicateSkipped: duplicate.skipped,
      reconciliation: verification.sessions.map((item) => ({
        state: item.state,
        ...("expected" in item ? { expected: item.expected, actual: item.actual } : {}),
      })),
      diagnosticCodes: [...new Set(bundle.diagnostics.map((issue) => issue.code))].sort(),
    };
    assertNoCredentials(report);
    await fs.writeFile("tmp/m5-live-runtime-report.json", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(report));
  });
}

try { await main(); }
catch (error) {
  // Assertion objects and transport errors must never print real transcripts.
  const normalized = normalizeError(error);
  console.error(JSON.stringify({ status: "failed", code: normalized.code }));
  process.exitCode = normalized.exitCode;
}
