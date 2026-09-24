import WebSocket from "ws";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import { isRuntimeObject } from "./reasoning-plan.js";
import type { TraeRuntimeTransport } from "./runtime-reader.js";

function unavailable(): Trae2OpenCodeError {
  return new Trae2OpenCodeError("T2O_TRAE_RUNTIME_UNAVAILABLE");
}

/** Explicit loopback endpoint only; never search for or restart desktop processes. */
export function validateTraeCdpUrl(value: string): URL {
  try {
    const url = new URL(value);
    const valid = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.port !== "" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
    if (valid) return url;
  } catch { /* Report a fixed error, never the input URL. */ }
  throw new Trae2OpenCodeError("T2O_TRAE_RUNTIME_ENDPOINT_INVALID");
}

async function targets(endpoint: URL): Promise<unknown[]> {
  const response = await fetch(new URL("/json/list", endpoint), {
    signal: AbortSignal.timeout(5_000), redirect: "error",
  });
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw unavailable();
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(value)) throw unavailable();
  return value;
}

// Version-pinned registry module from the installed TRAE CN 3.3.104 renderer.
// Importing an already loaded module reuses its registry. No UI/storage mutations.
const rendererApi = `
  const root = new URL("../../../../../", location.href);
  const product = await (await fetch(new URL("product.json", root))).json();
  if (product.appVersion !== "3.3.104" || !String(product.nameLong).includes("Trae CN"))
    throw new Error("Unsupported product");
  const module = await import(new URL("node_modules/@byted-icube/ai-modules-chat/dist/index.mjs", root).href);
  const api = module.__webpack_require__(8594).XT.tryResolve(Symbol.for("TraeApiPort"));
  if (!api?.chat?.getMessages || !api?.chat?.getSession) throw new Error("Runtime not ready");
`;

async function connectSocket(url: URL) {
  const socket = new WebSocket(url, { handshakeTimeout: 5_000, maxPayload: 34 * 1024 * 1024 });
  socket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", () => reject(unavailable()));
  });
  let sequence = 0;
  const evaluate = (expression: string): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const finish = (error?: unknown, result?: unknown) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      if (error) reject(error); else resolve(result);
    };
    const onClose = () => finish(unavailable());
    const timer = setTimeout(() => { finish(unavailable()); socket.terminate(); }, 30_000);
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.id !== id) return;
        const failed = message.error || message.result?.exceptionDetails ||
          message.result?.result?.type === "undefined";
        if (failed) finish(unavailable());
        else finish(undefined, message.result.result.value);
      } catch { finish(unavailable()); }
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.send(JSON.stringify({
      id, method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true, timeout: 29_000 },
    }), (error) => { if (error) finish(unavailable()); });
  });
  return { evaluate, close: () => socket.terminate() };
}

export async function connectTraeRuntime(endpoint: string, targetId?: string): Promise<TraeRuntimeTransport> {
  const url = validateTraeCdpUrl(endpoint);
  let connection: Awaited<ReturnType<typeof connectSocket>> | undefined;
  try {
    const candidates = (await targets(url)).filter((item) => isRuntimeObject(item) &&
      item.type === "page" && typeof item.url === "string" &&
      /\/out\/vs\/code\/electron-browser\/workbench\/workbench\.html(?:\?|$)/.test(item.url) &&
      (targetId === undefined || item.id === targetId));
    if (candidates.length !== 1) throw unavailable();
    const target = candidates[0] as Record<string, unknown>;
    const socketUrl = new URL(String(target.webSocketDebuggerUrl));
    const localSocket = socketUrl.protocol === "ws:" && socketUrl.hostname === url.hostname &&
      socketUrl.port === url.port && !socketUrl.username && !socketUrl.password;
    if (!localSocket) throw unavailable();
    connection = await connectSocket(socketUrl);
    const client = connection;
    const productVersion = await client.evaluate(`(async () => { ${rendererApi} return product.appVersion; })()`);
    if (productVersion !== "3.3.104") throw unavailable();
    return {
      productVersion,
      async invoke(method, params) {
        if (method !== "getSession" && method !== "getMessages") throw unavailable();
        const payload = JSON.stringify({ ...params, env: "local" });
        return client.evaluate(`(async () => { ${rendererApi}
          return api.chat[${JSON.stringify(method)}](${payload});
        })()`);
      },
      close: client.close,
    };
  } catch {
    connection?.close();
    throw unavailable();
  }
}
