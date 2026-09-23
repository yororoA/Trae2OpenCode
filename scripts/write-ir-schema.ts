import * as fs from "node:fs";
import * as path from "node:path";
import { migrationBundleSchema } from "../src/ir/schema.js";

const outputPath = path.join(
  process.cwd(),
  "schemas",
  "migration-bundle.v1.schema.json",
);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  `${JSON.stringify(migrationBundleSchema, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${outputPath}\n`);
