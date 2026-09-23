import assert from "node:assert/strict";
import * as http from "node:http";
import { describe, it } from "node:test";
import { WebSocketServer } from "ws";
import { connectTraeRuntime, validateTraeCdpUrl } from "../trae/runtime-cdp.js";

describe("TRAE CDP transport", () => {
  it("only accepts explicit loopback URLs without credentials, paths or redirects", () => {
    assert.equal(validateTraeCdpUrl("http://127.0.0.1:9222").port, "9222");
    assert.equal(validateTraeCdpUrl("http://[::1]:9222").hostname, "[::1]");
    for (const value of ["http://example.com:9222", "https://127.0.0.1:9222", "http://127.0.0.1",
      "http://user:secret@127.0.0.1:9222", "http://127.0.0.1:9222/path", "file:///tmp/"]) {
      assert.throws(() => validateTraeCdpUrl(value), { code: "T2O_TRAE_RUNTIME_ENDPOINT_INVALID" });
    }
  });

  it("selects a workbench explicitly, restricts methods and closes its socket", async () => {
    let port = 0;
    const expressions: string[] = [];
    const server = http.createServer((_request, response) => response.end(JSON.stringify(["a", "b"].map((id) => ({
      id, type: "page", url: "vscode-file://vscode-app/app/out/vs/workbench/workbench.html",
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}`,
    })))));
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      expressions.push(message.params.expression);
      const value = expressions.length === 1 ? "3.3.104" : { code: 0, data: { items: [] } };
      socket.send(JSON.stringify({ id: message.id, result: { result: { value } } }));
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    try {
      await assert.rejects(connectTraeRuntime(`http://127.0.0.1:${port}`), { code: "T2O_TRAE_RUNTIME_UNAVAILABLE" });
      const transport = await connectTraeRuntime(`http://127.0.0.1:${port}`, "a");
      try {
        assert.equal(transport.productVersion, "3.3.104");
        assert.deepEqual(await transport.invoke("getMessages", { chat_session_id: '";throw 1;//', env: "remote" }),
          { code: 0, data: { items: [] } });
        assert.ok(expressions[1].includes(JSON.stringify({ chat_session_id: '";throw 1;//', env: "local" })));
        assert.match(expressions[1], /TraeApiPort/);
        assert.doesNotMatch(expressions[1], /localStorage|executeCommand|sendMessage/);
      } finally { transport.close(); }
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
