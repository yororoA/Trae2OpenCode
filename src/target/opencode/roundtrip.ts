import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizeError, Trae2OpenCodeError } from "../../shared/errors.js";
import type { OpenCodeDialect } from "./contract.js";
import { exerciseOpenCodeRoundtrip } from "./compatibility.js";
import { withIsolatedOpenCodeServer } from "./isolated-server.js";

/** Public verification uses the same protocol gates and synthetic canary as migration. */
export async function verifyOpenCodeRoundtrip(options: {
  repository: string;
  output: string;
  binary?: string;
}) {
  try {
    const { report, schema } = await withIsolatedOpenCodeServer({
      binary: options.binary,
      temporaryRoot: path.resolve(options.repository, "tmp"),
    }, exerciseOpenCodeRoundtrip);
    const output = path.resolve(options.output);
    await fs.mkdir(output, { recursive: true });
    const schemaFile = report.dialect === "v1" ? "session.schema.json" : "transfer.schema.json";
    await fs.writeFile(path.join(output, schemaFile), JSON.stringify(schema, null, 2) + "\n");
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    return report;
  } catch (error) {
    // No native output, service password or temporary path may escape on failure.
    if (error instanceof Trae2OpenCodeError) throw error;
    throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
  }
}

export type OpenCodeVerificationTarget = {
  dialect: OpenCodeDialect;
  version: string;
  binary: string;
};

/** Multiple installed dialects are verified independently and receive separate evidence. */
export async function verifyOpenCodeRoundtrips(options: {
  repository: string;
  output: string;
  targets: readonly OpenCodeVerificationTarget[];
  verify?: typeof verifyOpenCodeRoundtrip;
}) {
  const verify = options.verify ?? verifyOpenCodeRoundtrip;
  const targets: Array<Record<string, unknown>> = [];
  const failures: Trae2OpenCodeError[] = [];
  for (const target of options.targets) {
    const output = path.join(path.resolve(options.output), target.dialect);
    try {
      const report = await verify({
        repository: options.repository,
        output,
        binary: target.binary,
      });
      if (report.dialect !== target.dialect || report.targetVersion !== target.version) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
      }
      targets.push({
        dialect: target.dialect,
        targetVersion: report.targetVersion,
        serverVersion: report.serverVersion,
        compatibility: report.compatibility,
        status: "verified",
        report: path.join(target.dialect, "report.json"),
      });
    } catch (error) {
      const failure = normalizeError(error);
      failures.push(failure);
      targets.push({
        dialect: target.dialect,
        targetVersion: target.version,
        status: "failed",
        code: failure.code,
        message: failure.message,
      });
    }
  }
  const report = {
    summaryVersion: 1,
    checkedAt: new Date().toISOString(),
    status: failures.length === 0 ? "verified" : "failed",
    targets,
  };
  const output = path.resolve(options.output);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return { report, failures };
}
