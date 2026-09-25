/** M0-4: contract probe against a private OpenCode process using synthetic data. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import { resolveOpenCodeBinary } from "./binary.js";

const exec = promisify(execFile);
const VERSION = "2.0.12";
const IMPORT_PATH = "/api/experimental/session/import";
const EXPORT_PATH = "/api/experimental/session/{sessionID}/export";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Message {
  id: string;
  type: string;
  time: { created: number; completed?: number };
  content?: Array<Record<string, Json>>;
  finish?: string;
  [key: string]: unknown;
}
interface Transfer {
  info: {
    id: string;
    projectID: string;
    time: { created: number; updated: number };
    location: { directory: string };
    model?: { id: string; providerID: string; variant?: string };
    parentID?: string;
    subpath?: string;
    [key: string]: unknown;
  };
  messages: Message[];
}
interface OpenApi {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, object> };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function differences(expected: unknown, actual: unknown, prefix = "$"): string[] {
  if (stable(expected) === stable(actual)) return [];
  if (expected === null || actual === null ||
      typeof expected !== "object" || typeof actual !== "object" ||
      Array.isArray(expected) !== Array.isArray(actual)) return [prefix];
  const left = expected as Record<string, unknown>;
  const right = actual as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key =>
    differences(left[key], right[key], Array.isArray(expected)
      ? `${prefix}[${key}]` : `${prefix}.${key}`));
}

/** Only include schemas reachable from the transfer contract, never runtime data. */
function transferSchema(api: OpenApi) {
  const schemas: Record<string, object> = {};
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string") {
        const prefix = "#/components/schemas/";
        assert.ok(item.startsWith(prefix), "External schema reference is unsupported");
        const name = item.slice(prefix.length);
        if (!schemas[name]) {
          assert.ok(api.components.schemas[name], `Missing schema: ${name}`);
          schemas[name] = api.components.schemas[name];
          visit(schemas[name]);
        }
      } else visit(item);
    }
  };
  visit({ $ref: "#/components/schemas/SessionTransfer.Data" });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: "#/components/schemas/SessionTransfer.Data",
    components: { schemas },
  };
}

async function stop(server: ChildProcess): Promise<void> {
  if (!server.pid || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise<void>(resolve => server.once("exit", () => resolve()));
  server.kill("SIGTERM");
  await Promise.race([exited, delay(3000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await exited;
  }
}

export async function verifyOpenCodeRoundtrip(options: {
  repository: string;
  output: string;
  binary?: string;
}) {
  const binary = resolveOpenCodeBinary(options.binary ?? "opencode");
  const repository = path.resolve(options.repository);
  const output = path.resolve(options.output);
  const temporary = path.join(repository, "tmp");
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, "m0-4-"));
  const password = randomBytes(32).toString("hex");
  let server: ChildProcess | undefined;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
    // Do not inherit existing config, auth, server URLs, or database overrides.
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCODE_DB: path.join(root, "data", "opencode", "probe.db"),
    OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"),
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_PASSWORD: password,
  };
  const run = async (args: string[]) => {
    const result = await exec(binary, args, {
      cwd: root, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      killSignal: "SIGKILL",
    });
    return result.stdout;
  };
  try {
    const version = (await run(["--version"])).trim().replace(/^opencode v?/, "");
    assert.equal(version, VERSION, `Only OpenCode ${VERSION} is mapped; refusing this version`);
    const template = JSON.parse(await fs.readFile(path.join(repository,
      "fixtures", "opencode", VERSION, "session-transfer.json"), "utf8")) as Transfer;
    const fixtureHash = hash(template);
    let serverOutput = "";
    let startupError: Error | undefined;
    server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => {
      serverOutput = (serverOutput + chunk.toString()).slice(-1024 * 1024);
    };
    server.stdout!.on("data", collect);
    server.stderr!.on("data", collect);
    server.on("error", error => { startupError = error; });
    let url: string | undefined;
    for (let tries = 0; tries < 150; tries++) {
      if (startupError) throw startupError;
      url = serverOutput.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) break;
      assert.equal(server.exitCode, null, "Private server exited during startup");
      await delay(200);
    }
    assert.ok(url, "Private server startup timed out");
    const request = async (route: string, body?: unknown) => {
      return fetch(url + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    };
    const apiResponse = await request("/openapi.json");
    assert.equal(apiResponse.status, 200, "OpenAPI unavailable");
    const api = await apiResponse.json() as OpenApi;
    assert.ok(api.paths[IMPORT_PATH]?.post, "Missing import capability");
    assert.ok(api.paths[EXPORT_PATH]?.get, "Missing export capability");
    await fs.access(env.OPENCODE_DB!);
    const schema = transferSchema(api);
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
    const validateTransfer = (data: unknown) => assert.ok(validate(data),
      "Transfer schema mismatch: " + JSON.stringify(validate.errors?.map(error => ({
        path: error.instancePath, keyword: error.keyword,
      }))));
    const cases: Array<Record<string, unknown>> = [];
    const expectedRewrites = new Set([
      "$.info.projectID", "$.info.model.variant", "$.info.time.updated", "$.info.subpath",
    ]);
    const make = (name: string) => {
      const data = structuredClone(template);
      data.info.id = `ses_m04_${name}`;
      data.info.location.directory = root;
      // Message IDs must be unique across imported sessions.
      data.messages.forEach(message => { message.id += `_${name}`; });
      return data;
    };
    const exportSession = async (id: string) => {
      const text = await run(["session", "export", id, "--server", url!]);
      const data = JSON.parse(text) as Transfer;
      validateTransfer(data);
      return data;
    };
    const check = async (name: string, source: Transfer, lostTail = false) => {
      validateTransfer(source);
      const input = path.join(root, "input.json");
      await fs.writeFile(input, JSON.stringify(source));
      await run(["session", "import", input, "--server", url!, "--directory", root]);
      const actual = await exportSession(source.info.id);
      const expectedMessages = lostTail ? source.messages.slice(0, -1) : source.messages;
      const messageDiff = differences(expectedMessages, actual.messages, "$.messages");
      assert.deepEqual(messageDiff, [], `${name}: unexpected message changes`);
      const infoChanges = differences(source.info, actual.info, "$.info");
      assert.ok(infoChanges.every(key => expectedRewrites.has(key)),
        `${name}: unexpected session changes: ${infoChanges.join(", ")}`);
      assert.ok(typeof actual.info.projectID === "string" && actual.info.projectID.length > 0);
      assert.equal(actual.info.model?.variant, "default");
      assert.ok(Number.isFinite(actual.info.time.updated));
      const apiExport = await request(EXPORT_PATH.replace("{sessionID}", source.info.id));
      assert.equal(apiExport.status, 200);
      const apiData = (await apiExport.json() as { data: Transfer }).data;
      assert.deepEqual(differences(actual, apiData), [], `${name}: CLI/API export disagree`);
      cases.push({
        name,
        schemaValid: true,
        cliApiReadbackEqual: true,
        sourceMessages: source.messages.length,
        readbackMessages: actual.messages.length,
        sourceMessagesSha256: hash(source.messages),
        readbackMessagesSha256: hash(actual.messages),
        messageDiff: differences(source.messages, actual.messages, "$.messages"),
        sessionChanges: infoChanges,
        fidelity: lostTail ? "loss-observed" : "exact-messages",
        lostMessageIds: lostTail ? [source.messages.at(-1)!.id] : [],
      });
      return actual;
    };

    const completed = make("completed");
    completed.messages = completed.messages.slice(0, 2);
    const completedReadback = await check("completed", completed);
    const duplicate = await request(IMPORT_PATH, completed);
    assert.equal(duplicate.status, 409, "Repeated session import must conflict");
    assert.deepEqual(differences(completedReadback, await exportSession(completed.info.id)), [],
      "Duplicate import changed the existing transcript");

    await check("unfinished-tools", make("unfinished_tools"), true);
    const textOnly = make("unfinished_text");
    textOnly.messages.at(-1)!.content = [{ type: "text", text: "Synthetic partial response." }];
    await check("unfinished-text", textOnly, true);
    const finishOnly = make("finish_only");
    finishOnly.messages.at(-1)!.finish = "stop";
    await check("finish-without-completed", finishOnly, true);
    // This synthetic variation isolates the export gate; never synthesize this
    // timestamp for real source data just to make an unfinished message visible.
    const activeTools = make("completed_active_tools");
    activeTools.messages.at(-1)!.time.completed = activeTools.info.time.updated;
    await check("completed-with-active-tools", activeTools);

    const child = make("child");
    child.messages = child.messages.slice(0, 2);
    child.info.parentID = completed.info.id;
    await check("child-after-parent", child);
    const orphan = make("orphan");
    orphan.info.parentID = "ses_m04_missing_parent";
    validateTransfer(orphan);
    assert.equal((await request(IMPORT_PATH, orphan)).status, 404);
    const orphanRead = await request(EXPORT_PATH.replace("{sessionID}", orphan.info.id));
    assert.equal(orphanRead.status, 404, "Rejected orphan left a session behind");
    const invalid = make("invalid");
    invalid.messages[0].type = "unknown-role";
    assert.equal(validate(invalid), false, "Schema accepted an unknown message type");
    assert.equal((await request(IMPORT_PATH, invalid)).status, 400);
    assert.equal((await request(EXPORT_PATH.replace("{sessionID}", invalid.info.id))).status, 404);

    const report = {
      reportVersion: 1,
      targetVersion: version,
      checkedAt: new Date().toISOString(),
      status: "verified-with-limitations",
      source: "synthetic-fixture-only",
      fixtureSha256: fixtureHash,
      schemaSha256: hash(schema),
      isolation: { privateServer: true, separateDatabase: true, separateXdgDirectories: true },
      checks: {
        duplicateImport: { status: 409, existingTranscriptUnchanged: true },
        missingParent: { status: 404, sessionAbsent: true },
        unknownMessageType: { schemaRejected: true, status: 400, sessionAbsent: true },
      },
      cases,
      limitations: [
        "Assistant messages without time.completed disappear from CLI and API export, even with finish=stop.",
        "Session projectID, subpath, time.updated and summary model.variant are projected by the target.",
        "This probe does not validate TRAE recovery, file attachments, other OpenCode versions or Windows.",
      ],
    };
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, "transfer.schema.json"), JSON.stringify(schema, null, 2) + "\n");
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    return report;
  } catch (error) {
    // Server credentials and temporary paths must never reach reports or logs.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(detail.replaceAll(password, "<redacted>")
      .replaceAll(root, "<isolated-root>").slice(0, 2000));
  } finally {
    if (server) await stop(server);
    await fs.rm(root, { recursive: true, force: true });
  }
}
