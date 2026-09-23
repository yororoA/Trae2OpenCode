/** Synthetic production-adapter integration; isolated target only, no source messages. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import type { AssistantEventIR, MigrationBundle, ToolContentIR } from "../src/ir/types.js";
import { withIsolatedOpenCodeServer } from "../src/target/opencode/isolated-server.js";
import { mapOpenCodeSession } from "../src/target/opencode/mapping.js";
import { createNativeOpenCodeAdapter } from "../src/target/opencode/native-adapter.js";
import { requireOpenCodeReconciliation } from "../src/target/opencode/reconciliation.js";

const fixture = JSON.parse(await fs.readFile(new URL(
  "../fixtures/ir/v1/valid-trae-assembled.json", import.meta.url,
), "utf8")) as MigrationBundle;

await withIsolatedOpenCodeServer({ temporaryRoot: "tmp" }, async (server) => {
  const adapter = createNativeOpenCodeAdapter({ ...server, temporaryRoot: server.directory });
  const reports = [];
  for (const variant of ["completed", "running", "streaming", "assistant_error", "child"] as const) {
    const bundle = structuredClone(fixture);
    const assistant = bundle.sessions[0].events[1] as AssistantEventIR;
    if (variant === "assistant_error") assistant.status = "error";
    if (variant === "running" || variant === "streaming") {
      const tool = assistant.content[3] as ToolContentIR;
      tool.status = variant;
      tool.input = variant === "streaming" ? '{"path":' : { path: "example.txt" };
      delete tool.output;
      delete tool.completedAt;
    }
    const { transfer } = mapOpenCodeSession(bundle, "session-synthetic", {
      sessionId: `ses_m46_${variant}`, directory: server.directory,
      messageIds: new Map([
        ["user-synthetic", `msg_m46_${variant}_u`],
        ["assistant-synthetic", `msg_m46_${variant}_a`],
      ]),
    });
    if (variant === "child") transfer.info.parentID = "ses_m46_completed";
    const actual = await adapter.importSession(transfer);
    const report = requireOpenCodeReconciliation(transfer, actual);
    assert.deepEqual(await adapter.exportSession(transfer.info.id), actual);
    await assert.rejects(adapter.importSession(transfer), { code: "T2O_OPENCODE_SESSION_CONFLICT" });
    reports.push({ variant, ...report });
  }
  const output = {
    version: "2.0.12", platform: process.platform, source: "synthetic-parser-to-ir-fixture",
    cliApiEqual: true, duplicatesRejected: true, reports,
  };
  await fs.writeFile("tmp/m4-6-adapter-report.json", JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify({ version: output.version, cases: reports.length, status: "verified" }));
});
