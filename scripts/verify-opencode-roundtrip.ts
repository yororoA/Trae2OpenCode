import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOpenCodeRoundtrip } from "../src/target/opencode/roundtrip";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output")) {
  process.stderr.write("Usage: npm run verify:opencode -- [--output <directory>]\n");
  process.exitCode = 1;
} else {
  try {
    const report = await verifyOpenCodeRoundtrip({
      repository,
      output: path.resolve(args[1] ?? path.join(repository, "tmp", "opencode-roundtrip")),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`OpenCode round-trip failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
