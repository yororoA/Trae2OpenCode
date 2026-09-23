import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  assertTraeParserCapability,
  hasVerifiedTraeRuntimeProfile,
  identifyTraeWorkspaceProfile,
  listTraeParserProfiles,
  resolveTraeParserProfile,
  RUNTIME_PROFILE,
  WORKSPACE_PROFILE,
} from "../trae/profile-definitions.js";

const selection = {
  productVersion: "3.3.104",
  profileId: "trae-cn-runtime-v2",
  profileVersion: 1,
};

describe("TRAE parser profile definitions", () => {
  it("resolves the exact verified product, source profile, and revision", () => {
    const runtime = resolveTraeParserProfile(selection);
    const workspace = resolveTraeParserProfile({ ...selection, profileId: WORKSPACE_PROFILE.id });
    assert.equal(runtime.sourceKind, "runtime");
    assert.equal(workspace.sourceKind, "workspace");
    assert.equal(runtime.verification, "verified");
    assert.deepStrictEqual(runtime.capabilities, [
      "runtime-metadata", "user-messages", "assistant-messages", "reasoning-plan", "tool-calls",
    ]);
    assert.deepStrictEqual(workspace.capabilities, ["session-metadata", "query-cache", "resources"]);
  });

  it("rejects missing, adjacent, editor, and loosely formatted product versions", () => {
    for (const productVersion of [null, "", "3.3.103", "3.3.105", "1.107.1", "v3.3.104", "3.3.104 ", "3.3.104-beta"]) {
      assert.throws(
        () => resolveTraeParserProfile({ ...selection, productVersion }),
        { code: "T2O_TRAE_PROFILE_VERSION_UNSUPPORTED", exitCode: 4 },
      );
      assert.equal(hasVerifiedTraeRuntimeProfile(productVersion), false);
    }
    assert.equal(hasVerifiedTraeRuntimeProfile("3.3.104"), true);
  });

  it("rejects unknown profile IDs without putting caller input in the error", () => {
    const profileId = "/Users/private-person/private-body";
    assert.throws(() => resolveTraeParserProfile({ ...selection, profileId }), (error: unknown) => {
      assert.ok(error instanceof Trae2OpenCodeError);
      assert.equal(error.code, "T2O_TRAE_PROFILE_UNKNOWN");
      assert.equal(error.exitCode, 4);
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-person|private-body/);
      return true;
    });
  });

  it("rejects unsupported revisions without coercion or nearest-version fallback", () => {
    for (const profileVersion of [0, 2, -1, 1.1, Number.NaN, "1" as unknown as number]) {
      assert.throws(
        () => resolveTraeParserProfile({ ...selection, profileVersion }),
        { code: "T2O_TRAE_PROFILE_REVISION_UNSUPPORTED" },
      );
    }
  });

  it("retains memento and hybrid registrations without permitting parsers", () => {
    for (const profileId of ["trae-cn-memento-v1", "trae-cn-hybrid"]) {
      const profile = listTraeParserProfiles().find((entry) => entry.id === profileId);
      assert.equal(profile?.verification, "unverified");
      assert.deepStrictEqual(profile?.capabilities, []);
      assert.throws(
        () => resolveTraeParserProfile({ ...selection, profileId }),
        { code: "T2O_TRAE_PROFILE_UNVERIFIED" },
      );
    }
  });

  it("prevents workspace capability from authorizing runtime messages or vice versa", () => {
    assert.equal(assertTraeParserCapability("3.3.104", RUNTIME_PROFILE, "user-messages").id, RUNTIME_PROFILE.id);
    assert.equal(assertTraeParserCapability("3.3.104", WORKSPACE_PROFILE, "resources").id, WORKSPACE_PROFILE.id);
    for (const [profile, capability] of [[WORKSPACE_PROFILE, "user-messages"], [RUNTIME_PROFILE, "query-cache"]] as const) {
      assert.throws(
        () => assertTraeParserCapability("3.3.104", profile, capability),
        { code: "T2O_TRAE_PROFILE_CAPABILITY_UNSUPPORTED" },
      );
    }
    assert.throws(
      () => assertTraeParserCapability("unknown", RUNTIME_PROFILE, "user-messages", "T2O_TRAE_USER_MESSAGE_VERSION_UNSUPPORTED"),
      { code: "T2O_TRAE_USER_MESSAGE_VERSION_UNSUPPORTED" },
    );
    assert.throws(
      () => assertTraeParserCapability("3.3.104", { ...RUNTIME_PROFILE, version: 2 }, "user-messages", "T2O_TRAE_USER_MESSAGE_VERSION_UNSUPPORTED"),
      { code: "T2O_TRAE_PROFILE_REVISION_UNSUPPORTED" },
    );
  });

  it("identifies storage shapes independently from runtime availability", () => {
    assert.deepStrictEqual(identifyTraeWorkspaceProfile("3.3.104", true, false), { id: WORKSPACE_PROFILE.id, verification: "verified" });
    assert.deepStrictEqual(identifyTraeWorkspaceProfile("3.3.104", true, true), { id: "trae-cn-hybrid", verification: "unverified" });
    assert.deepStrictEqual(identifyTraeWorkspaceProfile("3.3.104", false, true), { id: "trae-cn-memento-v1", verification: "unverified" });
    assert.deepStrictEqual(identifyTraeWorkspaceProfile("3.3.104", false, false), { id: "unknown", verification: "unsupported" });
    assert.deepStrictEqual(identifyTraeWorkspaceProfile("3.3.105", true, false), { id: "unknown", verification: "unsupported" });
  });

  it("does not allow consumers to mutate verification or capability registrations", () => {
    const profiles = listTraeParserProfiles();
    const runtime = resolveTraeParserProfile(selection);
    assert.equal(Reflect.set(runtime, "verification", "unverified"), false);
    assert.equal(Reflect.set(runtime.capabilities, 0, "query-cache"), false);
    assert.equal(Reflect.set(profiles, 0, {}), false);
    assert.equal(Reflect.set(RUNTIME_PROFILE, "version", 2), false);
    assert.equal(resolveTraeParserProfile(selection).capabilities[0], "runtime-metadata");
  });
});
