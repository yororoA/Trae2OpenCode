import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AssistantEventIR, MigrationBundle } from "../../ir/types.js";
import { createOpenCodeIdentityMap } from "../../target/opencode/identity.js";
import { mapOpenCodeSession } from "../../target/opencode/mapping.js";
import { readBundleFile } from "../bundle-file.js";
import { buildMigrationPlan, parsePathMaps, parseRecovery, summarizeMigrationPlan } from "../plan.js";

const fixture = () => readBundleFile("fixtures/ir/v1/valid-trae-assembled.json");
const options = { fallbackDirectory: process.cwd() };
const renamed = (bundle: MigrationBundle, id: string) =>
  JSON.parse(JSON.stringify(bundle.sessions[0]).replaceAll("session-synthetic", id));

describe("migration plan", () => {
  it("uses exactly the stable-ID mapping intended for import", async () => {
    const bundle = await fixture();
    const before = structuredClone(bundle);
    const plan = await buildMigrationPlan(bundle, options);
    const identity = createOpenCodeIdentityMap(bundle)[0];
    assert.equal(plan.sessions[0].status, "ready");
    assert.deepEqual(plan.sessions[0].transfer, mapOpenCodeSession(bundle, bundle.sessions[0].sourceId, {
      ...identity, directory: process.cwd(),
    }).transfer);
    assert.equal(plan.sessions[0].expected?.counts.messages, 2);
    assert.equal(plan.sessions[0].expected?.counts.tools, 1);
    assert.deepEqual(await buildMigrationPlan(bundle, options), plan);
    assert.deepEqual(bundle, before);
  });

  it("excludes metadata by default, while explicit inclusion still respects the mapping gate", async () => {
    const bundle = await fixture();
    bundle.sessions[0].recovery = "metadata-only";
    assert.equal((await buildMigrationPlan(bundle, options)).sessions[0].status, "excluded");
    const plan = await buildMigrationPlan(bundle, { ...options, recovery: ["metadata-only"] });
    assert.deepEqual(plan.sessions[0].reasons, ["T2O_OPENCODE_MAPPING_REJECTED"]);
    assert.equal(plan.sessions[0].transfer, undefined);
  });

  it("orders parents first and blocks children of excluded or rejected parents", async () => {
    const bundle = await fixture();
    const parent = renamed(bundle, "parent");
    bundle.sessions[0].parentSourceId = parent.sourceId;
    bundle.sessions.push(parent);
    let plan = await buildMigrationPlan(bundle, options);
    assert.deepEqual(plan.sessions.map((item) => item.sourceId), ["parent", "session-synthetic"]);
    assert.equal(plan.sessions[1].transfer?.info.parentID, plan.sessions[0].targetId);
    parent.recovery = "metadata-only";
    plan = await buildMigrationPlan(bundle, options);
    assert.deepEqual(plan.sessions.map((item) => item.status), ["excluded", "blocked"]);
    assert.deepEqual(plan.sessions[1].reasons, ["T2O_OPENCODE_PARENT_MISSING"]);
    parent.recovery = "partial";
    delete parent.createdAt;
    plan = await buildMigrationPlan(bundle, options);
    assert.deepEqual(plan.sessions.map((item) => item.status), ["blocked", "blocked"]);
  });

  it("isolates unimportable messages from another valid session", async () => {
    const bundle = await fixture();
    bundle.sessions.push(renamed(bundle, "valid"));
    delete (bundle.sessions[0].events[1] as AssistantEventIR).completedAt;
    const plan = await buildMigrationPlan(bundle, options);
    assert.deepEqual(plan.sessions.map((item) => item.status), ["blocked", "ready"]);
    assert.equal(plan.sessions[0].transfer, undefined);
  });

  it("does not create missing directories and accepts explicit cross-platform mapping", async () => {
    const bundle = await fixture();
    bundle.source.platform = "win32";
    bundle.sessions[0].projectPath = "C:\\source\\project";
    let plan = await buildMigrationPlan(bundle);
    assert.equal(plan.sessions[0].status, "blocked");
    plan = await buildMigrationPlan(bundle, {
      pathMaps: [{ from: "C:\\source\\project", to: process.cwd() }],
    });
    assert.equal(plan.sessions[0].directory?.strategy, "mapped");
    assert.equal(plan.sessions[0].transfer?.info.location.directory, process.cwd());
    plan = await buildMigrationPlan(bundle, { fallbackDirectory: path.join(process.cwd(), "absent-t2o-directory") });
    assert.deepEqual(plan.sessions[0].reasons, ["T2O_OPENCODE_DIRECTORY_INVALID"]);
  });

  it("snapshots caller inputs before asynchronous directory checks", async () => {
    const bundle = await fixture();
    const mutableOptions = { ...options };
    const pending = buildMigrationPlan(bundle, mutableOptions);
    bundle.sessions[0].title = "changed-after-call";
    mutableOptions.fallbackDirectory = "/changed-after-call";
    const plan = await pending;
    assert.equal(plan.sessions[0].status, "ready");
    assert.notEqual(plan.sessions[0].transfer?.info.title, "changed-after-call");
  });

  it("redacts source title, text and directory from reports but retains audit hashes", async () => {
    const bundle = await fixture();
    bundle.sessions[0].title = "private-title";
    const plan = await buildMigrationPlan(bundle, options);
    const summary = summarizeMigrationPlan(plan);
    assert.equal(summary.ready, 1);
    assert.equal(summary.blocked, 0);
    assert.match(summary.sessions[0].transferHash!, /^sha256:/);
    assert.doesNotMatch(JSON.stringify(summary), /private-title|First persisted|Read this file/);
    assert.ok(!JSON.stringify(summary).includes(process.cwd()));
  });

  it("validates CLI recovery and repeated path maps without echoing rejected values", () => {
    assert.deepEqual(parseRecovery(), ["complete", "partial"]);
    assert.deepEqual(parseRecovery("partial,complete,partial"), ["partial", "complete"]);
    assert.deepEqual(parsePathMaps(["/a=/b", "C:\\x=/y=z"]), [
      { from: "/a", to: "/b" }, { from: "C:\\x", to: "/y=z" },
    ]);
    for (const value of ["", "all", "complete,"]) {
      assert.throws(() => parseRecovery(value), { code: "T2O_CLI_INVALID_ARGUMENTS" });
    }
    for (const value of ["", "=x", "x=", "private-value"]) {
      assert.throws(() => parsePathMaps([value]), { code: "T2O_CLI_INVALID_ARGUMENTS" });
    }
  });
});
