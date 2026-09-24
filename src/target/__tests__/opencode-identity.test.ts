import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { MigrationBundle } from "../../ir/types.js";
import {
  createOpenCodeIdentityMap, stableOpenCodeMessageId, stableOpenCodeSessionId,
} from "../opencode/identity.js";
import { mapOpenCodeSession } from "../opencode/mapping.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../../../fixtures/ir/v1/valid-trae-assembled.json", import.meta.url,
), "utf8")) as MigrationBundle;
const graph = (parents: Record<string, string | undefined>) => {
  const bundle = structuredClone(fixture);
  bundle.sessions = Object.entries(parents).map(([sourceId, parentSourceId]) => ({
    ...structuredClone(fixture.sessions[0]), sourceId, events: [],
    ...(parentSourceId === undefined ? {} : { parentSourceId }),
  }));
  return bundle;
};
const rejected = { code: "T2O_OPENCODE_IDENTITY_INVALID" };

describe("OpenCode stable identity and dependency order", () => {
  it("keeps identities stable when content, source fingerprint and collection time change", () => {
    const original = createOpenCodeIdentityMap(fixture);
    const changed = structuredClone(fixture);
    changed.source.sourceFingerprint = `sha256:${"b".repeat(64)}`;
    changed.createdAt = "2026-09-25T00:00:00.000Z";
    changed.sessions[0].title = "changed";
    changed.sessions[0].events[0].createdAt! += 1;
    assert.deepEqual(createOpenCodeIdentityMap(changed), original);
    assert.match(original[0].sessionId, /^ses_t2o_[0-9a-f]{64}$/);
    assert.doesNotMatch(original[0].sessionId, /synthetic/);
    const { transfer } = mapOpenCodeSession(fixture, original[0].sourceSessionId,
      { ...original[0], directory: "/synthetic/target" });
    assert.equal(transfer.info.id, original[0].sessionId);
    const messageIds = [...original[0].messageIds.values()];
    assert.equal(messageIds.every((id, index) => index === 0 || messageIds[index - 1]! < id), true);
    assert.equal(messageIds.every((id) => id < "msg_0d000000000000000000000000"), true);
  });

  it("separates namespaces, kinds and per-session message identities", () => {
    const ids = [
      stableOpenCodeSessionId("source"), stableOpenCodeSessionId("source", "second"),
      stableOpenCodeMessageId("source", "message"), stableOpenCodeMessageId("second", "message"),
      stableOpenCodeMessageId("a:b", "c"), stableOpenCodeMessageId("a", "b:c"),
    ];
    assert.equal(new Set(ids).size, ids.length);
    assert.throws(() => stableOpenCodeSessionId(""), rejected);
    assert.throws(() => stableOpenCodeMessageId("a", ""), rejected);
    assert.throws(() => stableOpenCodeMessageId("a", "b", "trae-cn", -1), rejected);
    assert.throws(() => createOpenCodeIdentityMap(fixture, ""), rejected);
  });

  it("orders parents before children regardless of input order", () => {
    const bundle = graph({ child: "parent", parent: "root", sibling: "root", root: undefined });
    const expected = createOpenCodeIdentityMap(bundle);
    bundle.sessions.reverse();
    assert.deepEqual(createOpenCodeIdentityMap(bundle), expected);
    assert.deepEqual(expected.map((entry) => entry.sourceSessionId), ["root", "parent", "child", "sibling"]);
    assert.equal(expected[1].parentId, expected[0].sessionId);
    assert.equal(expected[2].parentId, expected[1].sessionId);
  });

  it("rejects missing parents, self references, cycles and duplicate session ids", () => {
    for (const parents of [{ a: "missing" }, { a: "a" }, { a: "b", b: "a" }]) {
      assert.throws(() => createOpenCodeIdentityMap(graph(parents)), rejected);
    }
    const duplicate = structuredClone(fixture);
    duplicate.sessions.push(structuredClone(duplicate.sessions[0]));
    assert.throws(() => createOpenCodeIdentityMap(duplicate), rejected);
  });

  it("rejects duplicate message identity inside a session", () => {
    const bundle = structuredClone(fixture);
    bundle.sessions[0].events[1].sourceId = bundle.sessions[0].events[0].sourceId;
    assert.throws(() => createOpenCodeIdentityMap(bundle), rejected);
  });

  it("handles a deep parent graph without recursive stack overflow", () => {
    const parents = Object.fromEntries(Array.from({ length: 12_000 }, (_, i) => [
      `node-${i}`, i === 11_999 ? undefined : `node-${i + 1}`,
    ]));
    const result = createOpenCodeIdentityMap(graph(parents));
    assert.equal(result.length, 12_000);
    assert.equal(result[0].sourceSessionId, "node-11999");
    assert.equal(result.at(-1)!.sourceSessionId, "node-0");
    assert.deepEqual(createOpenCodeIdentityMap(graph({})), []);
  });
});
