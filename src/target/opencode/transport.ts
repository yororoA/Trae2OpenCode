import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import { createStreamingJsonParser } from "../../shared/json-stream.js";
import {
  LARGE_TRANSFER_TIMEOUT_MS,
  MAX_OPENCODE_RESPONSE_BYTES,
} from "../../shared/limits.js";
import { resolveOpenCodeBinary } from "./binary.js";

const exec = promisify(execFile);

export interface OpenCodeTransport {
  run(args: readonly string[], options?: { cwd?: string }): Promise<string>;
  request(
    route: string,
    options?: { method?: "GET" | "DELETE" },
  ): Promise<{ status: number; body: unknown }>;
}

/** Credentials stay in process memory; URLs and command failures are never logged. */
export function createOpenCodeTransport(options: {
  serverUrl: string;
  binary?: string;
  password?: string;
  username?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): OpenCodeTransport {
  let url: URL;
  try {
    url = new URL(options.serverUrl);
  } catch {
    throw new Trae2OpenCodeError("T2O_OPENCODE_SERVER_INVALID");
  }
  const isLocalServer = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  const isRootUrl = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  if (!isLocalServer || !isRootUrl || url.protocol !== "http:") {
    throw new Trae2OpenCodeError("T2O_OPENCODE_SERVER_INVALID");
  }
  const baseUrl = url.origin;
  const timeoutMs = options.timeoutMs ?? LARGE_TRANSFER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_SERVER_INVALID");
  }
  // Copy caller options so later mutation cannot change the endpoint or credentials.
  const binary = resolveOpenCodeBinary(options.binary ?? "opencode");
  const cwd = options.cwd;
  const password = options.password;
  const username = options.username ?? "opencode";
  const env = {
    ...(options.env ?? process.env),
    ...(password !== undefined ? { OPENCODE_PASSWORD: password, OPENCODE_USERNAME: username } : {}),
  };
  const authorization = password === undefined
    ? undefined : `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  return {
    async run(args, runOptions) {
      try {
        // execFile intentionally avoids shell interpolation on both supported platforms.
        const result = await exec(binary, [...args], {
          cwd: runOptions?.cwd ?? cwd,
          env,
          timeout: timeoutMs,
          maxBuffer: MAX_OPENCODE_RESPONSE_BYTES,
          killSignal: "SIGKILL", windowsHide: true,
        });
        return result.stdout;
      } catch {
        // exec errors contain stdout/stderr, command args and potentially full messages.
        throw new Trae2OpenCodeError("T2O_OPENCODE_COMMAND_FAILED");
      }
    },
    async request(route, requestOptions) {
      const isLocalRoute = route.startsWith("/") && !route.startsWith("//") &&
        !route.includes("\\") && !route.includes("#");
      if (!isLocalRoute) throw new Trae2OpenCodeError("T2O_OPENCODE_SERVER_INVALID");
      try {
        const response = await fetch(baseUrl + route, {
          method: requestOptions?.method ?? "GET",
          headers: authorization ? { authorization } : {},
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Missing response");
        const parser = response.ok ? createStreamingJsonParser() : undefined;
        let length = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > MAX_OPENCODE_RESPONSE_BYTES) throw new Error("Response limit");
            parser?.write(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        // Error payloads need not be JSON and must not escape the transport.
        const body = parser?.end() ?? null;
        return { status: response.status, body };
      } catch {
        throw new Trae2OpenCodeError("T2O_OPENCODE_REQUEST_FAILED");
      }
    },
  };
}
