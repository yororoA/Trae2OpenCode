import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

// A package must never contain JavaScript left over from an earlier build.
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
const require = createRequire(import.meta.url);
const compilerPackage = require.resolve("typescript/package.json");
const compiler = resolve(dirname(compilerPackage), require(compilerPackage).bin.tsc);
const result = spawnSync(process.execPath, [compiler], {
  cwd: new URL("../", import.meta.url),
  stdio: "inherit",
  timeout: 120_000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
