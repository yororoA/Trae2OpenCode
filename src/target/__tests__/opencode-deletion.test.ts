import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { MigrationBundle } from "../../ir/types.js";
import { jsonHash } from "../../migration/ownership.js";
import { assertDeletionContract, createOpenCodeDeletionAdapter } from "../opencode/deletion.js";
import { mapOpenCodeSession } from "../opencode/mapping.js";
import type { OpenCodeTransport } from "../opencode/transport.js";

const contract = JSON.parse(readFileSync(new URL(
  "../../../fixtures/opencode/2.0.12/evidence/deletion.contract.json", import.meta.url,
), "utf8"));
const schema = JSON.parse(readFileSync(new URL(
  "../../../fixtures/opencode/2.0.12/evidence/transfer.schema.json", import.meta.url,
), "utf8"));
const bundle = JSON.parse(readFileSync(new URL(
  "../../../fixtures/ir/v1/valid-trae-assembled.json", import.meta.url,
), "utf8")) as MigrationBundle;

function setup() {
  const transfer = mapOpenCodeSession(bundle, "session-synthetic", {
    sessionId: "ses_target", directory: process.cwd(),
    messageIds: new Map([["user-synthetic", "msg_0001"], ["assistant-synthetic", "msg_0002"]]),
  }).transfer;
  const state = {
    stored: structuredClone(transfer) as typeof transfer | null, version: "2.0.12",
    api: { ...structuredClone(contract), components: { schemas: { ...schema.components.schemas, ...contract.components.schemas } } },
    pages: [{ data: [], cursor: { previous: null, next: null } }] as unknown[],
  };
  const requests: string[] = [];
  const deletes: string[][] = [];
  const transport: OpenCodeTransport = {
    async run(args) {
      if (args[0] === "--version") return state.version;
      deletes.push([...args]);
      state.stored = null;
      return "";
    },
    async request(route) {
      if (route === "/api/info") return { status: 200, body: { version: state.version } };
      if (route === "/openapi.json") return { status: 200, body: state.api };
      requests.push(route);
      return { status: 200, body: state.pages.shift() };
    },
  };
  const adapter = createOpenCodeDeletionAdapter(transport, "http://127.0.0.1:1234",
    async () => structuredClone(state.stored));
  return { adapter, state, transfer, requests, deletes };
}

describe("OpenCode guarded native deletion", () => {
  it("accepts the captured contract and refuses list/delete/schema drift", () => {
    assert.doesNotThrow(() => assertDeletionContract(contract));
    for (const operation of ["delete", "list", "schema"]) {
      const changed = structuredClone(contract);
      if (operation === "delete") delete changed.paths["/api/session/{sessionID}"].delete;
      if (operation === "list") changed.paths["/api/session"].get.parameters.pop();
      if (operation === "schema") changed.components.schemas.SessionsResponse.required.pop();
      assert.throws(() => assertDeletionContract(changed), { code: "T2O_OPENCODE_DELETE_UNSUPPORTED" });
    }
  });

  it("follows opaque pagination and validates every child's parent", async () => {
    const { adapter, state, requests } = setup();
    state.pages = [
      { data: [{ id: "ses_child1", parentID: "ses_target" }], cursor: { next: "opaque&next=value", previous: null } },
      { data: [{ id: "ses_child2", parentID: "ses_target" }], cursor: { next: null, previous: null } },
    ];
    assert.deepEqual(await adapter.listChildren("ses_target"), ["ses_child1", "ses_child2"]);
    assert.equal(new URL(requests[1], "http://localhost").searchParams.get("cursor"), "opaque&next=value");
    assert.ok(requests.every((route) => new URL(route, "http://localhost").searchParams.get("parentID") === "ses_target"));
  });

  it("rejects repeated cursors, missing pagination, duplicate IDs and wrong parents", async () => {
    for (const pages of [
      [{ data: [], cursor: { next: "same" } }, { data: [], cursor: { next: "same" } }],
      [{ data: [] }],
      [{ data: [], cursor: {} }],
      [{ data: [{ id: "ses_child", parentID: "ses_wrong" }], cursor: { next: null } }],
      [{ data: [{ id: "ses_target", parentID: "ses_target" }], cursor: { next: null } }],
      [{ data: [{ id: "ses_child", parentID: "ses_target" }, { id: "ses_child", parentID: "ses_target" }], cursor: { next: null } }],
    ]) {
      const { adapter, state, deletes } = setup();
      state.pages = pages;
      await assert.rejects(adapter.listChildren("ses_target"), { code: "T2O_OPENCODE_READBACK_INVALID" });
      assert.equal(deletes.length, 0);
    }
  });

  it("checks the exact readback hash and deletes only a leaf through literal CLI args", async () => {
    const { adapter, transfer, deletes } = setup();
    await adapter.deleteSession("ses_target", jsonHash(transfer), true);
    assert.deepEqual(deletes, [["session", "delete", "ses_target", "--server", "http://127.0.0.1:1234"]]);
  });

  it("never deletes without exclusive use or when content, children or version changed", async () => {
    for (const kind of ["exclusive", "content", "child", "version"]) {
      const { adapter, state, transfer, deletes } = setup();
      if (kind === "content") state.stored!.info.time.updated++;
      if (kind === "child") state.pages = [{ data: [{ id: "ses_child", parentID: "ses_target" }], cursor: { next: null } }];
      if (kind === "version") state.version = "2.0.13";
      const code = {
        exclusive: "T2O_MIGRATION_EXCLUSIVE_REQUIRED", content: "T2O_MIGRATION_TARGET_CHANGED",
        child: "T2O_MIGRATION_CHILDREN_PROTECTED", version: "T2O_OPENCODE_COMPATIBILITY_UNVERIFIED",
      }[kind];
      await assert.rejects(adapter.deleteSession("ses_target", jsonHash(transfer), kind !== "exclusive"), { code });
      assert.equal(deletes.length, 0);
    }
  });
});
