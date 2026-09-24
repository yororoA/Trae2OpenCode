/** Current real server/CLI round-trip and real adjacent binary fail-closed checks. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readBundleFile } from "../src/migration/bundle-file.js";
import { requireOpenCodeCapabilities, probeOpenCodeCapabilities } from "../src/target/opencode/capability-probe.js";
import { TRANSFER_SCHEMA_HASH } from "../src/target/opencode/contract.js";
import { withIsolatedOpenCodeServer } from "../src/target/opencode/isolated-server.js";
import { mapOpenCodeSession } from "../src/target/opencode/mapping.js";
import { createNativeOpenCodeAdapter } from "../src/target/opencode/native-adapter.js";
import { createOpenCodeTransport, type OpenCodeTransport } from "../src/target/opencode/transport.js";

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
  const adjacentNative = createOpenCodeTransport({
    binary: adjacent, serverUrl: server.serverUrl, cwd: server.directory,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      TEMP: server.directory, TMP: server.directory,
      XDG_CONFIG_HOME: server.directory, XDG_DATA_HOME: server.directory,
      XDG_CACHE_HOME: server.directory, XDG_STATE_HOME: server.directory,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
  });
  const calls: string[][] = [];
  let requests = 0;
  const adjacentTransport: OpenCodeTransport = {
    async run(args) {
      calls.push([...args]);
      // All observations come from the real 2.0.11 executable.
      return adjacentNative.run(args);
    },
    async request(route) {
      requests++;
      return server.transport.request(route);
    },
  };
  const rejected = await probeOpenCodeCapabilities(adjacentTransport);
  assert.equal(rejected.binaryVersion, "2.0.11");
  assert.equal(rejected.writable, false);
  assert.deepEqual(rejected.reasons, ["T2O_OPENCODE_VERSION_UNSUPPORTED"]);
  const incompatible = createNativeOpenCodeAdapter({
    serverUrl: server.serverUrl, transport: adjacentTransport, temporaryRoot: server.directory,
  });
  await assert.rejects(incompatible.importSession(transfer), { code: "T2O_OPENCODE_VERSION_UNSUPPORTED" });
  assert.equal(requests, 0);
  assert.deepEqual(calls, [["--version"], ["--version"]]);
  assert.equal(await native.readSession(transfer.info.id), null);
  let doctorCallback = false;
  await assert.rejects(withIsolatedOpenCodeServer({
    binary: adjacent, temporaryRoot: server.directory,
  }, async () => { doctorCallback = true; }), { code: "T2O_OPENCODE_VERSION_UNSUPPORTED" });
  assert.equal(doctorCallback, false);
  assert.equal((await fs.readdir(server.directory)).some((name) => name.startsWith("t2o-opencode-")), false);
  const actual = await native.importSession(transfer);
  assert.deepEqual(await native.exportSession(transfer.info.id), actual);
  baselineReport = {
    platform: process.platform, current: capabilities, adjacent: rejected,
    adjacentImportCalls: 0, adjacentServerRequests: requests,
    adjacentTargetAbsent: true, currentRoundTrip: true, status: "verified",
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
    compatibleReport = {
      server: nativeCapabilities,
      mixedClient: mixedCapabilities,
      mixedRoundTrip: true,
    };
  });
}

const report = {
  ...baselineReport,
  ...(compatibleReport ? { compatible: compatibleReport } : {}),
};
await fs.writeFile("tmp/m7-2-version-report.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
