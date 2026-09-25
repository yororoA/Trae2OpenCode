import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import { resolveOpenCodeBinary } from "./binary.js";
import { isSupportedOpenCodeVersion } from "./contract.js";
import { createOpenCodeTransport, type OpenCodeTransport } from "./transport.js";

async function stop(server: ChildProcess): Promise<void> {
  if (!server.pid || server.exitCode !== null || server.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => server.kill("SIGKILL"), 3000);
    server.once("exit", () => { clearTimeout(timer); resolve(); });
    server.kill("SIGTERM");
  });
}

export interface IsolatedOpenCodeServer {
  serverUrl: string;
  directory: string;
  transport: OpenCodeTransport;
  createTransport(binary?: string): OpenCodeTransport;
}

/** Disposable contract/doctor probe. Never reads the user's OpenCode configuration. */
export async function withIsolatedOpenCodeServer<T>(
  options: { binary?: string; temporaryRoot?: string },
  operation: (server: IsolatedOpenCodeServer) => Promise<T>,
): Promise<T> {
  const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  await fs.mkdir(temporaryRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporaryRoot, "t2o-opencode-"));
  await fs.chmod(root, 0o700);
  const password = randomBytes(32).toString("hex");
  const binary = resolveOpenCodeBinary(options.binary ?? "opencode");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: root,
    TMP: root,
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
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
  const connect = (serverUrl: string, clientBinary = binary) =>
    createOpenCodeTransport({ serverUrl, binary: clientBinary, env, cwd: root, password });
  let server: ChildProcess | undefined;
  try {
    const version = (await connect("http://127.0.0.1").run(["--version"])).trim();
    const parsedVersion = /^(?:opencode v?)?(\d+\.\d+\.\d+)$/.exec(version)?.[1] ?? null;
    if (!isSupportedOpenCodeVersion(parsedVersion)) {
      throw new Trae2OpenCodeError("T2O_OPENCODE_VERSION_UNSUPPORTED");
    }
    server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    let failed = false;
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8192); };
    server.stdout!.on("data", collect);
    server.stderr!.on("data", collect);
    server.on("error", () => { failed = true; });
    for (let attempt = 0; attempt < 150; attempt++) {
      if (failed || server.exitCode !== null || server.signalCode !== null) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_SERVER_START_FAILED");
      }
      const serverUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (serverUrl) {
        const transport = connect(serverUrl);
        return await operation({
          directory: root,
          serverUrl,
          transport,
          createTransport: (clientBinary) => connect(serverUrl, clientBinary),
        });
      }
      await delay(200);
    }
    throw new Trae2OpenCodeError("T2O_OPENCODE_SERVER_START_FAILED");
  } finally {
    if (server) await stop(server);
    await fs.rm(root, { recursive: true, force: true });
  }
}
