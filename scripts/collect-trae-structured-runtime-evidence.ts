import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeTraeStructuredRuntimeEvidence } from "../src/source/trae/structured-runtime-evidence";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

try {
  const probePath = path.resolve(argument("--probe"));
  const outputPath = path.resolve(argument("--output"));
  const report = normalizeTraeStructuredRuntimeEvidence(
    fs.readFileSync(probePath, "utf8"),
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      output: outputPath,
      status: report.verification.status,
      messages: report.counts.messages,
      planItems: report.counts.planItems,
      toolCalls: report.counts.toolCalls,
      evidenceSha256: report.evidenceSha256,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `Structured runtime evidence collection failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
}
