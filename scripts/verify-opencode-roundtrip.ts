import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { normalizeError } from "../src/shared/errors.js";
import { verifyOpenCodeRoundtrip } from "../src/target/opencode/roundtrip.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let values: { output?: string; binary?: string; json?: boolean } | undefined;
try {
  values = parseArgs({
    options: { output: { type: "string" }, binary: { type: "string" }, json: { type: "boolean" } },
  }).values;
} catch {
  process.stderr.write("Usage: npm run verify:opencode -- [--binary <path>] [--output <directory>] [--json]\n");
  process.exitCode = 2;
}
if (values) {
  const output = path.resolve(values.output ?? path.join(repository, "tmp", "opencode-roundtrip"));
  if (!values.json) process.stdout.write("正在检查 OpenCode 协议及隔离导入、回读...\n");
  try {
    const report = await verifyOpenCodeRoundtrip({
      repository, output,
      binary: values.binary ?? process.env.T2O_TEST_OPENCODE_BINARY,
    });
    process.stdout.write(values.json
      ? JSON.stringify(report) + "\n"
      : `OpenCode ${report.targetVersion}（${report.dialect}）验证通过：协议、隔离往返及删除保护。\n报告：${path.join(output, "report.json")}\n`);
  } catch (error) {
    const failure = normalizeError(error);
    process.stderr.write(values.json
      ? JSON.stringify({ status: "failed", code: failure.code, message: failure.message }) + "\n"
      : `OpenCode 验证失败：${failure.code} — ${failure.message}\n`);
    process.exitCode = failure.exitCode;
  }
}
