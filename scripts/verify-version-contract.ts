/** Reviewed releases and an unreviewed native binary must satisfy the actual protocol. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantEventIR, MigrationBundle } from "../src/ir/types.js";
import { readBundleFile } from "../src/migration/bundle-file.js";
import { buildMigrationPlan } from "../src/migration/plan.js";
import { migrate, verifyMigration } from "../src/migration/executor.js";
import { rollbackMigration } from "../src/migration/rollback.js";
import { createMigrationTarget } from "../src/migration/target.js";
import { requireOpenCodeCapabilities, probeOpenCodeCapabilities } from "../src/target/opencode/capability-probe.js";
import { assertOpenCodeTransfer, TRANSFER_SCHEMA_HASH } from "../src/target/opencode/contract.js";
import { withIsolatedOpenCodeServer } from "../src/target/opencode/isolated-server.js";
import {
  mapOpenCodeSession,
  MAX_CONTINUATION_CONTEXT_BYTES,
  type OpenCodeTransfer,
} from "../src/target/opencode/mapping.js";
import { createNativeOpenCodeAdapter } from "../src/target/opencode/native-adapter.js";

function requireHiddenCompaction(value: unknown): void {
  assertOpenCodeTransfer(value);
  const transfer = value as OpenCodeTransfer;
  const boundary = transfer.messages.find((message) => message.type === "compaction");
  assert.equal(boundary?.summary, "");
  assert.match(String(boundary?.recent), /\[Assistant\]:/);
}

function forceCompaction(bundle: MigrationBundle): void {
  const assistant = bundle.sessions[0].events.find(
    (event): event is AssistantEventIR => event.type === "assistant",
  );
  const text = assistant?.content.find((item) => item.type === "text");
  assert.ok(text?.type === "text");
  text.text = "x".repeat(MAX_CONTINUATION_CONTEXT_BYTES + 1);
}

const adjacent = path.resolve(process.env.T2O_TEST_ADJACENT_BINARY ??
  "tmp/opencode-adjacent/node_modules/@opencode/cli/bin/opencode.exe");
const current = process.env.T2O_TEST_OPENCODE_BINARY;
const compatible = process.env.T2O_TEST_COMPATIBLE_BINARY;
let baselineReport: Record<string, unknown> | undefined;
await withIsolatedOpenCodeServer({
  temporaryRoot: "tmp", ...(current ? { binary: path.resolve(current) } : {}),
}, async (server) => {
  const capabilities = await requireOpenCodeCapabilities(server.transport);
  assert.equal(capabilities.schemaHash, TRANSFER_SCHEMA_HASH);
  const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
  const { transfer } = mapOpenCodeSession(bundle, "session-synthetic", {
    sessionId: "ses_version_contract", directory: server.directory,
    messageIds: new Map([
      ["user-synthetic", "msg_version_0001"],
      ["assistant-synthetic", "msg_version_0002"],
    ]),
  });
  const native = createNativeOpenCodeAdapter({ ...server, temporaryRoot: server.directory });
  const adjacentTransport = server.createTransport(adjacent);
  const rejected = await probeOpenCodeCapabilities(adjacentTransport);
  assert.equal(rejected.binaryVersion, "2.0.11");
  assert.equal(rejected.writable, false);
  assert.deepEqual(rejected.reasons, ["T2O_OPENCODE_COMPATIBILITY_BINARY_REQUIRED"]);
  const incompatible = createNativeOpenCodeAdapter({
    serverUrl: server.serverUrl, transport: adjacentTransport, temporaryRoot: server.directory,
  });
  await assert.rejects(incompatible.importSession(transfer), { code: "T2O_OPENCODE_COMPATIBILITY_BINARY_REQUIRED" });
  assert.equal(await native.readSession(transfer.info.id), null);
  const actual = await native.importSession(transfer);
  assert.deepEqual(await native.exportSession(transfer.info.id), actual);
  const compactionBundle = structuredClone(bundle);
  forceCompaction(compactionBundle);
  const compacted = mapOpenCodeSession(compactionBundle, "session-synthetic", {
    sessionId: "ses_version_contract_compacted",
    directory: server.directory,
    messageIds: new Map([
      ["user-synthetic", "msg_version_compacted_0001"],
      ["assistant-synthetic", "msg_version_compacted_0002"],
    ]),
  }).transfer;
  requireHiddenCompaction(compacted);
  requireHiddenCompaction(await native.importSession(compacted));
  requireHiddenCompaction((await native.readSession(compacted.info.id))!);
  baselineReport = {
    platform: process.platform, current: capabilities, adjacent: rejected,
    adjacentTargetAbsent: true, currentRoundTrip: true,
    hiddenCompactionRoundTrip: true, status: "verified",
  };
});

let unreviewedReport: Record<string, unknown> | undefined;
await withIsolatedOpenCodeServer({ binary: adjacent, temporaryRoot: "tmp" }, async (server) => {
  const capabilities = await requireOpenCodeCapabilities(server.transport);
  assert.equal(capabilities.binaryVersion, "2.0.11");
  assert.equal(capabilities.serverVersion, "2.0.11");
  assert.equal(capabilities.compatibility, "isolated-roundtrip");
  const plan = await buildMigrationPlan(await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json"), {
    dialect: capabilities.dialect, targetVersion: capabilities.binaryVersion!,
    fallbackDirectory: server.directory,
  });
  const target = createMigrationTarget({
    serverUrl: server.serverUrl, transport: server.transport, temporaryRoot: server.directory,
  });
  // The canary must not have imported its synthetic sessions into this target.
  const existing = await server.transport.request("/api/session?limit=100");
  assert.equal(existing.status, 200);
  assert.deepEqual((existing.body as { data: unknown[] }).data, []);
  const outputDirectory = path.join(server.directory, "migration");
  const first = await migrate(plan, target, { outputDirectory });
  assert.equal(first.verified, 1);
  assert.equal(first.hasFailures, false);
  const manifest = path.join(outputDirectory, first.manifest);
  assert.equal((await verifyMigration(manifest, target)).hasFailures, false);
  assert.equal((await migrate(plan, target, { resumeManifest: manifest })).hasFailures, false);
  assert.equal((await rollbackMigration(manifest, target, {
    confirm: first.runId, exclusiveTarget: true,
  })).hasFailures, false);
  assert.equal(await target.readSession(plan.sessions[0].targetId), null);
  unreviewedReport = {
    version: capabilities.binaryVersion, compatibility: capabilities.compatibility,
    targetEmptyAfterCanary: true, migration: true, verify: true, resume: true, rollback: true,
  };
});

let compatibleReport: Record<string, unknown> | undefined;
if (compatible) {
  const compatibleBinary = path.resolve(compatible);
  await withIsolatedOpenCodeServer({
    temporaryRoot: "tmp",
    binary: compatibleBinary,
  }, async (server) => {
    const nativeCapabilities = await requireOpenCodeCapabilities(server.transport);
    assert.equal(nativeCapabilities.binaryVersion, "2.0.16");
    assert.equal(nativeCapabilities.serverVersion, "2.0.16");
    assert.equal(nativeCapabilities.schemaHash, TRANSFER_SCHEMA_HASH);

    const mixedTransport = server.createTransport(
      current ? path.resolve(current) : "opencode",
    );
    const mixedCapabilities = await requireOpenCodeCapabilities(mixedTransport);
    assert.equal(mixedCapabilities.binaryVersion, "2.0.12");
    assert.equal(mixedCapabilities.serverVersion, "2.0.16");
    assert.equal(mixedCapabilities.schemaHash, TRANSFER_SCHEMA_HASH);

    const bundle = await readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
    const { transfer } = mapOpenCodeSession(bundle, "session-synthetic", {
      sessionId: "ses_version_contract_2016",
      directory: server.directory,
      messageIds: new Map([
        ["user-synthetic", "msg_version_2016_0001"],
        ["assistant-synthetic", "msg_version_2016_0002"],
      ]),
    });
    const mixed = createNativeOpenCodeAdapter({
      serverUrl: server.serverUrl,
      transport: mixedTransport,
      temporaryRoot: server.directory,
    });
    const actual = await mixed.importSession(transfer);
    assert.deepEqual(await mixed.exportSession(transfer.info.id), actual);
    const compactionBundle = structuredClone(bundle);
    forceCompaction(compactionBundle);
    const compacted = mapOpenCodeSession(compactionBundle, "session-synthetic", {
      sessionId: "ses_version_contract_2016_compacted",
      directory: server.directory,
      messageIds: new Map([
        ["user-synthetic", "msg_version_2016_compacted_0001"],
        ["assistant-synthetic", "msg_version_2016_compacted_0002"],
      ]),
    }).transfer;
    requireHiddenCompaction(compacted);
    requireHiddenCompaction(await mixed.importSession(compacted));
    requireHiddenCompaction((await mixed.readSession(compacted.info.id))!);
    compatibleReport = {
      server: nativeCapabilities,
      mixedClient: mixedCapabilities,
      mixedRoundTrip: true,
      hiddenCompactionRoundTrip: true,
    };
  });
}

const report = {
  ...baselineReport,
  unreviewed: unreviewedReport,
  ...(compatibleReport ? { compatible: compatibleReport } : {}),
};
await fs.writeFile("tmp/m7-2-version-report.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
