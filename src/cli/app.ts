import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface CliIO {
  stdout(message: string): void;
  stderr(message: string): void;
}

const PLANNED_COMMANDS = [
  ["doctor", "Check TRAE and OpenCode prerequisites"],
  ["scan", "Inventory recoverable TRAE data"],
  ["preview", "Preview mappings and diagnostics"],
  ["export", "Export a versioned migration bundle"],
  ["migrate", "Import sessions through OpenCode"],
  ["verify", "Reconcile a completed migration"],
  ["rollback", "Remove sessions created by a migration"],
] as const;

const defaultIO: CliIO = {
  stdout(message) {
    process.stdout.write(message);
  },
  stderr(message) {
    process.stderr.write(message);
  },
};

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };

  if (typeof packageJson.version !== "string") {
    throw new Error("package.json does not contain a valid version");
  }

  return packageJson.version;
}

function formatHelp(version: string): string {
  const commandLines = PLANNED_COMMANDS.map(
    ([name, description]) => `  ${name.padEnd(10)} ${description}`,
  ).join("\n");

  return `Trae2OpenCode ${version}

Usage:
  trae2opencode [options]
  trae2opencode <command> [options]

Commands:
${commandLines}
  help       Show this help
  version    Show the version

Options:
  -h, --help     Show this help
  -V, --version  Show the version
`;
}

function writeError(io: CliIO, message: string): number {
  io.stderr(`Error: ${message}\nRun "trae2opencode --help" for usage.\n`);
  return 1;
}

export function runCli(
  args: readonly string[],
  io: CliIO = defaultIO,
  version = readPackageVersion(),
): number {
  let parsed: ReturnType<typeof parseArgs>;

  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        help: {
          type: "boolean",
          short: "h",
        },
        version: {
          type: "boolean",
          short: "V",
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return writeError(io, message);
  }

  if (parsed.values.help) {
    io.stdout(formatHelp(version));
    return 0;
  }

  if (parsed.values.version) {
    io.stdout(`${version}\n`);
    return 0;
  }

  if (parsed.positionals.length === 0) {
    io.stdout(formatHelp(version));
    return 0;
  }

  if (parsed.positionals.length > 1) {
    return writeError(
      io,
      `Unexpected arguments: ${parsed.positionals.slice(1).join(" ")}`,
    );
  }

  const [command] = parsed.positionals;
  if (command === "help") {
    io.stdout(formatHelp(version));
    return 0;
  }

  if (command === "version") {
    io.stdout(`${version}\n`);
    return 0;
  }

  const isPlannedCommand = PLANNED_COMMANDS.some(([name]) => name === command);
  if (isPlannedCommand) {
    io.stderr(`Command "${command}" is not implemented yet.\n`);
    return 2;
  }

  return writeError(io, `Unknown command "${command}"`);
}
