import * as fs from "node:fs";
import * as path from "node:path";
import { collectTraeRuntimeEvidence } from "../src/source/trae/runtime-evidence";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

try {
  const logPath = path.resolve(argument("--log"));
  const sessionId = argument("--session-id");
  const productVersion = argument("--product-version");
  const outputPath = path.resolve(argument("--output"));
  const report = collectTraeRuntimeEvidence(
    fs.readFileSync(logPath, "utf8"),
    sessionId,
    productVersion,
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({
      output: outputPath,
      status: report.verification.status,
      historyReads: report.history.observations.length,
      turnSamples: report.turns.samples.length,
      pairedToolCalls: report.tools.pairedCalls,
    }) + "\n",
  );
} catch (error) {
  process.stderr.write(
    `Runtime evidence collection failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
}
