import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { createOpenCodeTransport } from "../opencode/transport.js";

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  operation: (url: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("createOpenCodeTransport", () => {
  it("accepts only explicit local HTTP origins and valid time limits", () => {
    for (const serverUrl of [
      "not a url", "https://127.0.0.1", "http://example.com", "http://127.0.0.1/path",
      "http://user:pass@localhost", "http://localhost?token=secret", "http://localhost#fragment",
      "file:///tmp/a",
    ]) {
      assert.throws(() => createOpenCodeTransport({ serverUrl }), { code: "T2O_OPENCODE_SERVER_INVALID" });
    }
    for (const timeoutMs of [0, -1, Infinity, 300_001]) {
      assert.throws(() => createOpenCodeTransport({ serverUrl: "http://localhost", timeoutMs }),
        { code: "T2O_OPENCODE_SERVER_INVALID" });
    }
    assert.doesNotThrow(() => createOpenCodeTransport({ serverUrl: "http://[::1]:1234" }));
  });

  it("reads JSON with authentication and freezes caller settings", async () => {
    await withServer((request, response) => {
      assert.equal(request.url, "/api/info");
      assert.equal(request.headers.authorization, `Basic ${Buffer.from("opencode:synthetic").toString("base64")}`);
      response.end('{"version":"2.0.12"}');
    }, async (serverUrl) => {
      const options = { serverUrl, password: "synthetic" };
      const transport = createOpenCodeTransport(options);
      options.password = "changed";
      options.serverUrl = "http://example.com";
      assert.deepStrictEqual(await transport.request("/api/info"), { status: 200, body: { version: "2.0.12" } });
    });
  });

  it("rejects redirects and route escapes without forwarding credentials", async () => {
    let hits = 0;
    await withServer((_request, response) => {
      hits++;
      response.writeHead(302, { location: "http://example.invalid/private" });
      response.end();
    }, async (serverUrl) => {
      const transport = createOpenCodeTransport({ serverUrl, password: "synthetic" });
      for (const route of ["//example.invalid/a", "/\\example.invalid", "https://example.invalid", "/a#fragment"]) {
        await assert.rejects(transport.request(route), { code: "T2O_OPENCODE_SERVER_INVALID" });
      }
      assert.equal(hits, 0);
      await assert.rejects(transport.request("/redirect"), { code: "T2O_OPENCODE_REQUEST_FAILED" });
      assert.equal(hits, 1);
    });
  });

  it("drops error bodies and contains invalid JSON without leaking values", async () => {
    await withServer((request, response) => {
      response.statusCode = request.url === "/error" ? 401 : 200;
      response.end("private body /Users/private secret");
    }, async (serverUrl) => {
      const transport = createOpenCodeTransport({ serverUrl });
      assert.deepStrictEqual(await transport.request("/error"), { status: 401, body: null });
      await assert.rejects(transport.request("/invalid"), (error: unknown) => {
        assert.equal((error as { code: string }).code, "T2O_OPENCODE_REQUEST_FAILED");
        assert.doesNotMatch(String(error), /private|secret/);
        return true;
      });
    });
  });

  it("cancels a stalled response within the configured timeout", async () => {
    await withServer(() => {}, async (serverUrl) => {
      const transport = createOpenCodeTransport({ serverUrl, timeoutMs: 50 });
      await assert.rejects(transport.request("/stalled"), { code: "T2O_OPENCODE_REQUEST_FAILED" });
    });
  });

  it("rejects oversized streamed responses", async () => {
    await withServer((_request, response) => response.end(Buffer.alloc(32 * 1024 * 1024 + 1, " ")), async (serverUrl) => {
      await assert.rejects(createOpenCodeTransport({ serverUrl }).request("/large"),
        { code: "T2O_OPENCODE_REQUEST_FAILED" });
    });
  });

  it("passes arguments literally and contains subprocess stderr", async () => {
    const transport = createOpenCodeTransport({ serverUrl: "http://localhost", binary: process.execPath });
    const literal = 'space $(whoami) `private` "quote"';
    const result = await transport.run(["-e", "process.stdout.write(process.argv[1])", "--", literal]);
    assert.equal(result, literal);
    await assert.rejects(transport.run(["-e", "console.error('private-secret'); process.exit(1)"]), (error: unknown) => {
      assert.equal((error as { code: string }).code, "T2O_OPENCODE_COMMAND_FAILED");
      assert.doesNotMatch(String(error), /private-secret/);
      assert.equal((error as Error).cause, undefined);
      return true;
    });
  });

  it("terminates a stalled child instead of leaving it running", async () => {
    const transport = createOpenCodeTransport({
      serverUrl: "http://localhost", binary: process.execPath, timeoutMs: 100,
    });
    await assert.rejects(transport.run(["-e", "setInterval(() => {}, 1000)"]),
      { code: "T2O_OPENCODE_COMMAND_FAILED" });
  });
});
