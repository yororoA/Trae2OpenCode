#!/usr/bin/env tsx
/**
 * Fixture 采集 CLI — 在安装了 TRAE 的机器上运行，生成脱敏的结构化报告。
 *
 * 用法:
 *   npx tsx scripts/collect-fixtures.ts
 *   npx tsx scripts/collect-fixtures.ts --trae-root /path/to/Trae/User
 *   npx tsx scripts/collect-fixtures.ts --product-version 3.3.104
 */

import { collectToFile } from "../src/fixture-collector/index";

function parseArgs(): {
  traeRoot?: string;
  productVersion?: string;
  maxWorkspaces?: number;
  output?: string;
} {
  const args = process.argv.slice(2);
  const opts: ReturnType<typeof parseArgs> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--trae-root":
        opts.traeRoot = args[++i];
        break;
      case "--product-version":
        opts.productVersion = args[++i];
        break;
      case "--max-workspaces":
        opts.maxWorkspaces = parseInt(args[++i], 10);
        break;
      case "--output":
        opts.output = args[++i];
        break;
      case "--help":
      case "-h":
        console.log(`
使用方法: npx tsx scripts/collect-fixtures.ts [选项]

选项:
  --trae-root <path>    指定 TRAE User 数据目录路径
  --product-version <v> TRAE 客户端版本
  --max-workspaces <n>  限制处理的 workspace 数量
  --output <path>       输出 JSON 报告路径 (默认: fixtures/fixture-report.json)
  --help, -h            显示此帮助信息
        `.trim());
        process.exit(0);
    }
  }

  return opts;
}

const opts = parseArgs();

console.log("[FixtureCollector] 开始采集 TRAE 数据目录结构...");
console.log("[FixtureCollector] 注意: 只记录结构、类型和 hash，不记录原始内容。");

try {
  const outputPath = collectToFile(opts);
  console.log(`[FixtureCollector] 报告已生成: ${outputPath}`);
} catch (err) {
  console.error(
    "[FixtureCollector] 采集失败:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
}
