import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getDiagnosticLocation } from "../shared/diagnostics.js";
import { Trae2OpenCodeError, normalizeError } from "../shared/errors.js";
import { type Clock, JsonLogger } from "../shared/logger.js";

export interface CliIO {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliRuntime {
  clock?: Clock;
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
  -h, --help          Show this help
  -V, --version       Show the version
      --json          Emit machine-readable output and errors
      --trae-root <path>
                      Override the TRAE data root
`;
}

function writeError(
  io: CliIO,
  error: unknown,
  options: {
    json: boolean;
    clock?: Clock;
    context?: Record<string, unknown>;
  },
): number {
  const normalized = normalizeError(error);
  if (options.json) {
    const logger = new JsonLogger(io.stderr, options.clock);
    logger.error("cli.error", normalized, options.context);
    for (const diagnostic of normalized.diagnostics) {
      logger.diagnostic("cli.diagnostic", diagnostic);
    }
    return normalized.exitCode;
  }

  io.stderr(`Error [${normalized.code}]: ${normalized.message}\n`);
  for (const diagnostic of normalized.diagnostics) {
    const location = getDiagnosticLocation(diagnostic);
    const locationPrefix = location ? `${location}: ` : "";
    io.stderr(
      `  - [${diagnostic.code}] ${locationPrefix}${diagnostic.message}\n`,
    );
  }

  const isUsageError =
    normalized.code === "T2O_CLI_INVALID_ARGUMENTS" ||
    normalized.code === "T2O_CLI_UNKNOWN_COMMAND";
  if (isUsageError) {
    io.stderr('Run "trae2opencode --help" for usage.\n');
  }

  return normalized.exitCode;
}

export function runCli(
  args: readonly string[],
  io: CliIO = defaultIO,
  version?: string,
  runtime: CliRuntime = {},
): number {
  let parsed: ReturnType<typeof parseArgs>;
  const jsonRequested = args.includes("--json");

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
        json: {
          type: "boolean",
        },
        "trae-root": {
          type: "string",
        },
      },
    });
  } catch (cause) {
    return writeError(
      io,
      new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS", { cause }),
      {
        json: jsonRequested,
        clock: runtime.clock,
      },
    );
  }

  const useJson = parsed.values.json === true;
  let resolvedVersion: string;
  try {
    resolvedVersion = version ?? readPackageVersion();
  } catch (cause) {
    return writeError(
      io,
      new Trae2OpenCodeError("T2O_INTERNAL_UNEXPECTED", { cause }),
      {
        json: useJson,
        clock: runtime.clock,
      },
    );
  }

  if (parsed.values.help) {
    io.stdout(formatHelp(resolvedVersion));
    return 0;
  }

  if (parsed.values.version) {
    const output = useJson
      ? JSON.stringify({ version: resolvedVersion })
      : resolvedVersion;
    io.stdout(`${output}\n`);
    return 0;
  }

  if (parsed.positionals.length === 0) {
    io.stdout(formatHelp(resolvedVersion));
    return 0;
  }

  if (parsed.positionals.length > 1) {
    return writeError(
      io,
      new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS"),
      {
        json: useJson,
        clock: runtime.clock,
        context: {
          count: parsed.positionals.length - 1,
        },
      },
    );
  }

  const [command] = parsed.positionals;
  if (command === "help") {
    io.stdout(formatHelp(resolvedVersion));
    return 0;
  }

  if (command === "version") {
    const output = useJson
      ? JSON.stringify({ version: resolvedVersion })
      : resolvedVersion;
    io.stdout(`${output}\n`);
    return 0;
  }

  const isPlannedCommand = PLANNED_COMMANDS.some(([name]) => name === command);
  if (isPlannedCommand) {
    return writeError(
      io,
      new Trae2OpenCodeError("T2O_CLI_COMMAND_NOT_IMPLEMENTED"),
      {
        json: useJson,
        clock: runtime.clock,
        context: {
          command,
        },
      },
    );
  }

  return writeError(
    io,
    new Trae2OpenCodeError("T2O_CLI_UNKNOWN_COMMAND"),
    {
      json: useJson,
      clock: runtime.clock,
    },
  );
}
