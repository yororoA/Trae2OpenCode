import Database from "better-sqlite3";
import { exportBundleFile, readBundleFile, summarizeBundle } from "../migration/bundle-file.js";
import { buildMigrationPlan, parsePathMaps, parseRecovery, summarizeMigrationPlan } from "../migration/plan.js";
import { migrate, verifyMigration } from "../migration/executor.js";
import { createMigrationTarget } from "../migration/target.js";
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
  dryRun?: boolean;
  namespace?: string;
  recovery?: string;
  pathMaps?: string[];
  fallbackDirectory?: string;
  manifest?: string;
  resume?: string;
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
  const planningOption = options.dryRun || options.namespace !== undefined ||
    options.recovery !== undefined || options.pathMaps !== undefined || options.fallbackDirectory !== undefined;
  if (command !== "migrate" && planningOption) throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
  if (command !== "migrate" && options.resume) throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
  if (command !== "verify" && options.manifest) throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
  const targetOptions = {
    serverUrl: options.server ?? "", binary: options.binary,
    password: process.env.OPENCODE_SERVER_PASSWORD, username: process.env.OPENCODE_SERVER_USERNAME,
  };
  if (command === "verify") {
    const sourceOptions = options.input || options.cdp || options.traeRoot || options.productFile ||
      options.cdpTarget || options.session || options.project || options.output;
    if (!options.server || !options.manifest || sourceOptions) {
      throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
    }
    return verifyMigration(options.manifest, createMigrationTarget(targetOptions));
  }
  if (command === "migrate") {
    const invalidDryRun = options.dryRun && (options.output || options.resume);
    const invalidWrite = !options.dryRun &&
      (!options.server || Boolean(options.output) === Boolean(options.resume));
    if (invalidDryRun || invalidWrite) throw new Trae2OpenCodeError("T2O_CLI_INVALID_ARGUMENTS");
    const recovery = parseRecovery(options.recovery);
    const pathMaps = parsePathMaps(options.pathMaps);
    const bundle = await loadCommandBundle(options);
    const plan = await buildMigrationPlan(bundle, {
      recovery, pathMaps, namespace: options.namespace, fallbackDirectory: options.fallbackDirectory,
    });
    if (!options.dryRun) {
      return migrate(plan, createMigrationTarget(targetOptions), {
        outputDirectory: options.output, resumeManifest: options.resume,
      });
    }
    const target = options.server ? await probeOpenCodeCapabilities(createOpenCodeTransport({
      serverUrl: options.server, binary: options.binary,
      password: process.env.OPENCODE_SERVER_PASSWORD, username: process.env.OPENCODE_SERVER_USERNAME,
    })) : { probed: false };
    return { command, dryRun: true, target, ...summarizeMigrationPlan(plan) };
  }
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
