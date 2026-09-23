import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import * as path from "node:path";

// Expand files ourselves: cmd.exe does not expand shell globs on Windows.
function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(filename);
    return entry.name.endsWith(".test.ts") ? [filename] : [];
  });
}

const files = testFiles("src").sort();
if (files.length === 0) throw new Error("No test files found");
const result = spawnSync(process.execPath, [
  "--import", "tsx", "--test", ...process.argv.slice(2), ...files,
], { stdio: "inherit", timeout: 300_000, windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
