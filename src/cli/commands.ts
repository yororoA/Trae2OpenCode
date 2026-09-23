import Database from "better-sqlite3";
import { exportBundleFile, readBundleFile, summarizeBundle } from "../migration/bundle-file.js";
import { collectTraeBundle, detectTraeVersion, selectBundle } from "../source/trae/collect.js";
import { probeTraeCapabilities } from "../source/trae/capability-probe.js";
import { requireTraeRoot } from "../source/trae/path-discovery.js";
import { connectTraeRuntime } from "../source/trae/runtime-cdp.js";
import { normalizeError, Trae2OpenCodeError } from "../shared/errors.js";
import { probeOpenCodeCapabilities } from "../target/opencode/capability-probe.js";
import { createOpenCodeTransport } from "../target/opencode/transport.js";

export interface CommandOptions {
  traeRoot?: string;
  productFile?: string;
  cdp?: string;
  cdpTarget?: string;
  input?: string;
  output?: string;
  session?: string;
  project?: string;
  server?: string;
  binary?: string;
}

export async function loadCommandBundle(options: CommandOptions) {
  if (options.input) {
    if (options.cdp || options.traeRoot || options.productFile || options.cdpTarget) {
      throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
    }
    return selectBundle(await readBundleFile(options.input), options);
  }
  if (options.cdpTarget && !options.cdp) throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
  const transport = options.cdp ? await connectTraeRuntime(options.cdp, options.cdpTarget) : undefined;
  try {
    const productVersion = transport?.productVersion ?? await detectTraeVersion(options.productFile);
    return await collectTraeBundle({ ...options, productVersion, transport });
  } finally { transport?.close(); }
}

export async function executeReadCommand(command: string, options: CommandOptions): Promise<unknown> {
  if (command === "doctor") {
    const report: Record<string, unknown> = { command, reportVersion: 1 };
    try {
      const database = new Database(":memory:");
      try { report.sqlite = database.prepare("SELECT sqlite_version() AS version").get(); }
      finally { database.close(); }
    } catch { report.sqlite = { available: false }; }
    try {
      const root = requireTraeRoot({ traeRoot: options.traeRoot });
      const productVersion = await detectTraeVersion(options.productFile);
      report.trae = await probeTraeCapabilities({
        root, productVersion,
        ...(options.cdp ? { runtimeProbe: async () => {
          const transport = await connectTraeRuntime(options.cdp as string, options.cdpTarget);
          transport.close();
          return true;
        } } : {}),
      });
    } catch (error) { report.trae = { available: false, code: normalizeError(error).code }; }
    report.opencode = options.server
      ? await probeOpenCodeCapabilities(createOpenCodeTransport({
        serverUrl: options.server, binary: options.binary,
        password: process.env.OPENCODE_SERVER_PASSWORD, username: process.env.OPENCODE_SERVER_USERNAME,
      }))
      : { probed: false, reason: "Provide --server to check native import capabilities." };
    return report;
  }
  if (!["scan", "preview", "export"].includes(command)) {
    throw new Trae2OpenCodeError("T2O_CLI_COMMAND_NOT_IMPLEMENTED");
  }
  if (command === "export" && !options.output) throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
  const bundle = await loadCommandBundle(options);
  const summary = summarizeBundle(bundle);
  return command === "export"
    ? { command, ...summary, artifact: await exportBundleFile(bundle, options.output as string) }
    : { command, ...summary };
}
