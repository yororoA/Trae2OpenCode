import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Trae2OpenCodeError, normalizeError } from "../src/shared/errors.js";
import {
  verifyOpenCodeRoundtrip,
  verifyOpenCodeRoundtrips,
} from "../src/target/opencode/roundtrip.js";
import {
  discoverOpenCodeTargets,
  preferredOpenCodeTargets,
  requestedOpenCodeTargets,
} from "../src/cli/opencode-targets.js";

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
    const explicitBinary = values.binary ?? process.env.T2O_TEST_OPENCODE_BINARY;
    if (explicitBinary) {
      const report = await verifyOpenCodeRoundtrip({
        repository, output, binary: explicitBinary,
      });
      process.stdout.write(values.json
        ? JSON.stringify(report) + "\n"
        : `OpenCode ${report.targetVersion}（${report.dialect}）验证通过：协议、隔离往返及删除保护。\n报告：${path.join(output, "report.json")}\n`);
    } else {
      const discovered = preferredOpenCodeTargets(await discoverOpenCodeTargets());
      const targets = requestedOpenCodeTargets(
        process.env.T2O_OPENCODE_TARGETS,
        discovered,
      ) ?? discovered;
      if (targets.length === 0) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_VERSION_UNSUPPORTED");
      }
      if (targets.length === 1) {
        const report = await verifyOpenCodeRoundtrip({
          repository, output, binary: targets[0].binary,
        });
        process.stdout.write(values.json
          ? JSON.stringify(report) + "\n"
          : `OpenCode ${report.targetVersion}（${report.dialect}）验证通过：协议、隔离往返及删除保护。\n报告：${path.join(output, "report.json")}\n`);
      } else {
        const result = await verifyOpenCodeRoundtrips({ repository, output, targets });
        const summary = JSON.stringify(result.report);
        if (values.json) {
          (result.failures.length ? process.stderr : process.stdout).write(summary + "\n");
        } else {
          for (const target of result.report.targets) {
            const label = `OpenCode ${String(target.targetVersion)}（${String(target.dialect)}）`;
            if (target.status === "verified") {
              process.stdout.write(`${label}验证通过：协议、隔离往返及删除保护。\n`);
            } else {
              process.stderr.write(`${label}验证失败：${String(target.code)} — ${String(target.message)}\n`);
            }
          }
          process.stdout.write(`汇总报告：${path.join(output, "report.json")}\n`);
        }
        if (result.failures[0]) process.exitCode = result.failures[0].exitCode;
      }
    }
  } catch (error) {
    const failure = normalizeError(error);
    process.stderr.write(values.json
      ? JSON.stringify({ status: "failed", code: failure.code, message: failure.message }) + "\n"
      : `OpenCode 验证失败：${failure.code} — ${failure.message}\n`);
    process.exitCode = failure.exitCode;
  }
}
