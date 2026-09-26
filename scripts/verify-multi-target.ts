import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hashCanonicalJson } from "../src/ir/canonical.js";
import type { JsonValue } from "../src/ir/types.js";
import { readBundleFile } from "../src/migration/bundle-file.js";
import { migrate } from "../src/migration/executor.js";
import { readManifest } from "../src/migration/manifest.js";
import { buildMigrationPlan } from "../src/migration/plan.js";
import { createMigrationTarget } from "../src/migration/target.js";
import { requireOpenCodeCapabilities } from "../src/target/opencode/capability-probe.js";
import { withIsolatedOpenCodeServer } from "../src/target/opencode/isolated-server.js";

const binaries = [
  {
    dialect: "v1" as const,
    binary: path.resolve(process.env.T2O_TEST_OPENCODE_V1_BINARY ??
      "tmp/opencode-v1-current/node_modules/opencode-ai/bin/opencode.exe"),
  },
  {
    dialect: "v2" as const,
    binary: path.resolve(process.env.T2O_TEST_OPENCODE_V2_BINARY ??
      process.env.T2O_TEST_OPENCODE_BINARY ??
      "tmp/opencode/node_modules/@opencode/cli/bin/opencode.exe"),
  },
];
const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
const bundleHash = hashCanonicalJson(bundle as unknown as JsonValue);
const outputRoot = path.resolve("tmp/multi-target");
await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
const results: Array<Record<string, unknown>> = [];

for (const item of binaries) {
  await withIsolatedOpenCodeServer({
    binary: item.binary,
    temporaryRoot: "tmp",
  }, async (server) => {
    const capabilities = await requireOpenCodeCapabilities(server.transport);
    assert.equal(capabilities.dialect, item.dialect);
    const plan = await buildMigrationPlan(structuredClone(bundle), {
      dialect: capabilities.dialect,
      targetVersion: capabilities.binaryVersion!,
      fallbackDirectory: server.directory,
    });
    assert.deepEqual(plan.sessions.map((session) => session.status), ["ready"]);
    const outputDirectory = path.join(outputRoot, item.dialect);
    const target = createMigrationTarget({
      serverUrl: server.serverUrl,
      transport: server.transport,
      temporaryRoot: server.directory,
    });
    const migrated = await migrate(plan, target, { outputDirectory });
    assert.equal(migrated.hasFailures, false);
    assert.equal(migrated.verified, 1);
    const manifest = await readManifest(path.join(outputDirectory, migrated.manifest));
    assert.equal(manifest.target.binaryVersion, capabilities.binaryVersion);
    assert.ok(await target.readSession(plan.sessions[0].targetId));
    results.push({
      dialect: item.dialect,
      version: capabilities.binaryVersion,
      manifest: path.relative(outputRoot, path.join(outputDirectory, migrated.manifest)),
      verified: migrated.verified,
      status: "verified",
    });
  });
}

assert.equal(hashCanonicalJson(bundle as unknown as JsonValue), bundleHash);
assert.deepEqual(results.map((item) => item.dialect), ["v1", "v2"]);
const report = {
  platform: process.platform,
  node: process.version,
  source: "shipped-synthetic-ir",
  sharedBundleUnchanged: true,
  isolatedTargetRecords: true,
  results,
  status: "verified",
};
await fs.writeFile(
  path.join(outputRoot, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
