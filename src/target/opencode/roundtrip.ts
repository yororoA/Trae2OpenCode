import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Trae2OpenCodeError } from "../../shared/errors.js";
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
