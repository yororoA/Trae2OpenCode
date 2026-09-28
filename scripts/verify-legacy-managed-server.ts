import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  startManagedOpenCodeServer,
} from "../src/cli/interactive-migrate.js";
import { resolveOpenCodeBinary } from "../src/target/opencode/binary.js";

const configured = process.env.T2O_TEST_V2_LEGACY_BINARY;
assert.ok(configured, "Set T2O_TEST_V2_LEGACY_BINARY to OpenCode 2.0.0");
const binary = resolveOpenCodeBinary(path.resolve(configured));
await fs.mkdir("tmp", { recursive: true });
const root = await fs.mkdtemp(path.resolve("tmp", "legacy-managed-server-"));
Object.assign(process.env, {
  HOME: root,
  USERPROFILE: root,
  APPDATA: path.join(root, "roaming"),
  LOCALAPPDATA: path.join(root, "local"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_STATE_HOME: path.join(root, "state"),
  OPENCODE_CONFIG_CONTENT: "{}",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
});

let server: Awaited<ReturnType<typeof startManagedOpenCodeServer>> | undefined;
try {
  server = await startManagedOpenCodeServer(binary, "v2");
  const authorization = `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`;
  const response = await fetch(new URL("/api/health", server.url), {
    headers: { authorization },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { healthy?: unknown; version?: unknown };
  assert.equal(body.healthy, true);
  assert.equal(body.version, "2.0.0");
  const report = {
    platform: process.platform,
    node: process.version,
    version: body.version,
    serviceDescriptorFallback: true,
    loopbackOnly: new URL(server.url).hostname === "127.0.0.1",
    status: "verified",
  };
  await fs.writeFile(
    "tmp/m7-2-legacy-startup-report.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await server?.close();
  await fs.rm(root, { recursive: true, force: true });
}
