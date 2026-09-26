import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { MigrationBundle } from "../src/ir/types.js";
import { buildMigrationPlan } from "../src/migration/plan.js";
import { migrate, verifyMigration } from "../src/migration/executor.js";
import { rollbackMigration } from "../src/migration/rollback.js";
import { createMigrationTarget } from "../src/migration/target.js";
import { readBundleFile } from "../src/migration/bundle-file.js";
import { probeOpenCodeCapabilities } from "../src/target/opencode/capability-probe.js";
import { isVerifiedOpenCodeVersion } from "../src/target/opencode/contract.js";
import { resolveOpenCodeBinary } from "../src/target/opencode/binary.js";
import { withIsolatedOpenCodeServer } from "../src/target/opencode/isolated-server.js";

/**
 * Baseline and unreviewed compatible OpenCode 1.x releases use their real native binary:
 * version, health, `/doc` routes, the reviewed schema hash, a real import/export round
 * trip with readback reconciliation, conflict detection and rollback.
 */
// Convention mirrors verify-version-contract: current binary from PATH unless
// T2O_TEST_OPENCODE_BINARY overrides it; adjacent native release from
// tmp/opencode-v1-adjacent unless T2O_TEST_V1_ADJACENT_BINARY overrides it.
const adjacentDefault = path.resolve("tmp/opencode-v1-adjacent/node_modules/opencode-ai/bin/opencode.exe");
const configured = [
  { label: "current", value: process.env.T2O_TEST_OPENCODE_BINARY ?? "opencode" },
  {
    label: "adjacent",
    value: process.env.T2O_TEST_V1_ADJACENT_BINARY ??
      (existsSync(adjacentDefault) ? adjacentDefault : undefined),
  },
].filter((entry): entry is { label: string; value: string } => typeof entry.value === "string");

assert.ok(configured.length > 0, "Set T2O_TEST_OPENCODE_BINARY and/or T2O_TEST_V1_ADJACENT_BINARY");

const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
const results: unknown[] = [];

async function verifyVersion(label: string, binary: string) {
  const resolved = resolveOpenCodeBinary(binary);
  await withIsolatedOpenCodeServer({ binary: resolved }, async (server) => {
    const capabilities = await probeOpenCodeCapabilities(server.transport);
    assert.equal(capabilities.writable, true, `${label}: expected a writable target`);
    assert.equal(capabilities.dialect, "v1", `${label}: expected the v1 dialect`);
    assert.equal(capabilities.binaryVersion, capabilities.serverVersion);
    assert.ok(capabilities.schemaHash, `${label}: missing schema hash`);
    assert.equal(capabilities.compatibility, isVerifiedOpenCodeVersion(capabilities.binaryVersion)
      ? "verified-release" : "isolated-roundtrip");

    const plan = await buildMigrationPlan(structuredClone(bundle) as MigrationBundle, {
      dialect: capabilities.dialect,
      targetVersion: capabilities.binaryVersion!,
      fallbackDirectory: server.directory,
    });
    assert.deepEqual(plan.sessions.map((item) => item.status), ["ready"]);
    const target = createMigrationTarget({ serverUrl: server.serverUrl, transport: server.transport });
    assert.equal(await target.readSession(plan.sessions[0]!.targetId), null);
    const output = `${server.directory}/run`;
    const first = await migrate(plan, target, { outputDirectory: output });
    assert.equal(first.verified, plan.sessions.length);
    assert.equal(first.hasFailures, false);

    const readback = await target.readSession(plan.sessions[0]!.targetId);
    assert.ok(readback, `${label}: missing readback`);
    assert.deepEqual(readback.messages.map((message) => message.info.role), ["user", "assistant"]);
    const parts = readback.messages[1]!.parts as Array<{ type: string }>;
    assert.deepEqual(parts.map((part) => part.type), ["reasoning", "text", "reasoning", "tool", "text"]);

    const verified = await verifyMigration(`${output}/${first.manifest}`, target);
    assert.equal(verified.hasFailures, false);
    const resumed = await migrate(plan, target, { resumeManifest: `${output}/${first.manifest}` });
    assert.equal(resumed.hasFailures, false);
    assert.equal(resumed.verified, first.verified);

    const second = await migrate(plan, target, { outputDirectory: `${server.directory}/run2` });
    assert.equal(second.verified, 0);

    const rolledBack = await rollbackMigration(`${output}/${first.manifest}`, target, {
      confirm: first.runId, exclusiveTarget: true,
    });
    assert.equal(rolledBack.hasFailures, false);
    assert.equal(await target.readSession(plan.sessions[0]!.targetId), null);

    results.push({
      label, binary: resolved, version: capabilities.binaryVersion,
      compatibility: capabilities.compatibility, resume: true,
      schemaHash: capabilities.schemaHash, messages: readback.messages.length,
      parts: parts.length, status: "verified",
    });
  });
  console.log(`${label}: ${results.at(-1) && JSON.stringify(results.at(-1))}`);
}

for (const entry of configured) await verifyVersion(entry.label, entry.value);

console.log(JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2));
