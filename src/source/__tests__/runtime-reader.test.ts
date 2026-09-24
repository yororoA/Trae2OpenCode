import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTraeRuntimeReader, type TraeRuntimeTransport } from "../trae/runtime-reader.js";

const sessionId = "session-runtime";
const message = (id: string) => ({ chat_session_id: sessionId, message_id: id, content: "正文" });
const page = (items: unknown[], next_page_token?: unknown) => ({ code: 0, data: { items, next_page_token } });
const listedSession = (id: string) => ({
  chat_session_id: id,
  session_type: "side_chat",
  title: id,
});
function setup(pages: unknown[]) {
  const requests: Record<string, unknown>[] = [];
  const transport: TraeRuntimeTransport = {
    productVersion: "3.3.104",
    async invoke(_method, params) { requests.push(params); return pages.shift(); },
    close() {},
  };
  return { transport, requests, reader: createTraeRuntimeReader(transport) };
}

describe("createTraeRuntimeReader", () => {
  it("paginates and deduplicates the current project session list", async () => {
    const { reader, requests } = setup([
      { code: 0, data: {
        items: [listedSession("session-a"), listedSession("session-b")],
        next_page_token: "more",
        total: 3,
      } },
      { code: 0, data: {
        items: [listedSession("session-b"), listedSession("session-c")],
        total: 3,
      } },
    ]);

    assert.deepEqual(await reader.readSessionList(), [
      listedSession("session-a"),
      listedSession("session-b"),
      listedSession("session-c"),
    ]);
    assert.deepEqual(requests, [
      { page_size: 100 },
      { page_size: 100, page_token: "more" },
    ]);
  });

  it("rejects malformed or incomplete project session lists", async () => {
    for (const pages of [
      [{ code: 1, data: { items: [] } }],
      [{ code: 0, data: { items: [{ chat_session_id: "session-a", session_type: "other" }] } }],
      [{ code: 0, data: { items: [listedSession("session-a")], total: 2 } }],
      [
        { code: 0, data: { items: [listedSession("session-a")], next_page_token: "loop" } },
        { code: 0, data: { items: [listedSession("session-b")], next_page_token: "loop" } },
      ],
    ]) {
      await assert.rejects(setup(pages).reader.readSessionList(), {
        code: "T2O_TRAE_RUNTIME_READ_INVALID",
      });
    }
  });

  it("uses local pagination, deduplicates overlap, and counts the complete read", async () => {
    const { reader, requests } = setup([page([message("b"), message("c")], "older"), page([message("a"), message("b")])]);
    const result = await reader.readMessages(sessionId);
    assert.equal(result.expectedMessageCount, 3);
    assert.deepEqual(result.value, [message("b"), message("c"), message("a")]);
    assert.deepEqual(requests, [
      { chat_session_id: sessionId, env: "local", page_size: 20 },
      { chat_session_id: sessionId, env: "local", page_size: 20, page_token: "older" },
    ]);
  });

  it("rejects API failure, foreign IDs, conflicting overlap, and invalid pages", async () => {
    for (const pages of [
      [{ code: 1, data: { items: [] } }],
      [page([{ ...message("a"), chat_session_id: "foreign-session" }])],
      [page([message("a")], "older"), page([{ ...message("a"), content: "changed" }])],
      [{ code: 0, data: { items: null } }],
      [page([message("a")], 12)],
      [{ code: 0, data: { items: [], has_more: true } }],
    ]) {
      await assert.rejects(setup(pages).reader.readMessages(sessionId), { code: "T2O_TRAE_RUNTIME_READ_INVALID" });
    }
  });

  it("rejects looping or empty continuation pages without returning partial content", async () => {
    for (const pages of [
      [page([message("a")], "loop"), page([message("a")], "loop")],
      [page([], "more")],
    ]) {
      await assert.rejects(setup(pages).reader.readMessages(sessionId), { code: "T2O_TRAE_RUNTIME_READ_INVALID" });
    }
  });

  it("enforces byte and page limits", async () => {
    const first = setup([page([message("a")], "more")]);
    await assert.rejects(createTraeRuntimeReader(first.transport, { maxPages: 1 }).readMessages(sessionId),
      { code: "T2O_TRAE_RUNTIME_LIMIT" });
    const second = setup([page([message("a")])]);
    await assert.rejects(createTraeRuntimeReader(second.transport, { maxBytes: 1 }).readMessages(sessionId),
      { code: "T2O_TRAE_RUNTIME_LIMIT" });
  });

  it("validates version, session identifiers, metadata identity and closes transport", async () => {
    const { transport, reader } = setup([{ code: 0, data: { chat_session_id: sessionId, title: "Title" } }]);
    assert.deepEqual(await reader.readMetadata([sessionId]), [{ chat_session_id: sessionId, title: "Title" }]);
    await assert.rejects(reader.readMessages("../bad"), { code: "T2O_TRAE_RUNTIME_READ_INVALID" });
    await assert.rejects(setup([{ code: 0, data: { chat_session_id: "foreign-session" } }]).reader.readMetadata([sessionId]),
      { code: "T2O_TRAE_RUNTIME_READ_INVALID" });
    assert.throws(() => createTraeRuntimeReader({ ...transport, productVersion: "3.3.105" }),
      { code: "T2O_TRAE_PROFILE_VERSION_UNSUPPORTED" });
    let closed = false;
    createTraeRuntimeReader({ ...transport, close() { closed = true; } }).close();
    assert.equal(closed, true);
  });

  it("isolates one stale metadata identity while preserving valid sessions", async () => {
    const secondId = "session-second";
    const { reader } = setup([
      { code: 0, data: { chat_session_id: sessionId, title: "First" } },
      { code: 1, data: null },
      { code: 0, data: { chat_session_id: secondId, title: "Second" } },
    ]);
    assert.deepEqual(await reader.readMetadata([sessionId, "session-stale", secondId]), [
      { chat_session_id: sessionId, title: "First" },
      { chat_session_id: secondId, title: "Second" },
    ]);
  });
});
