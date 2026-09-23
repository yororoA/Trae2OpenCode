import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getMessageSourceLocations,
  probeAiAgentDatabase,
  probeMessageSources,
} from "../source-locations";
import { validateTraeStructuredRuntimeEvidence } from "../../source/trae/structured-runtime-evidence";

const temporaryDirectories: string[] = [];

function createTraeDataRoot(databaseHeader?: Buffer): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trae-source-probe-"));
  temporaryDirectories.push(root);

  const userDataPath = path.join(root, "User");
  fs.mkdirSync(userDataPath);

  if (databaseHeader) {
    const databaseDirectory = path.join(root, "ModularData", "ai-agent");
    fs.mkdirSync(databaseDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(databaseDirectory, "database.db"),
      databaseHeader,
    );
  }

  return userDataPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("probeAiAgentDatabase", () => {
  it("returns null when the ai-agent database is absent", () => {
    const userDataPath = createTraeDataRoot();

    assert.strictEqual(probeAiAgentDatabase(userDataPath), null);
  });

  it("reports a plain SQLite header without exposing an absolute path", () => {
    const userDataPath = createTraeDataRoot(
      Buffer.from("SQLite format 3\0fixture", "ascii"),
    );

    const result = probeAiAgentDatabase(userDataPath);

    assert.ok(result);
    assert.strictEqual(
      result.relativePath,
      "ModularData/ai-agent/database.db",
    );
    assert.strictEqual(result.format, "sqlite");
    assert.deepStrictEqual(result.sidecars, { wal: false, shm: false });
    assert.ok(!JSON.stringify(result).includes(userDataPath));
  });

  it("classifies a non-SQLite header as opaque without guessing encryption", () => {
    const userDataPath = createTraeDataRoot(
      Buffer.from("not-a-sqlite-header", "ascii"),
    );

    assert.strictEqual(probeAiAgentDatabase(userDataPath)?.format, "opaque");
  });
});

describe("message source map", () => {
  it("has an explicit source status for every required content kind", () => {
    const locations = getMessageSourceLocations();

    assert.deepStrictEqual(
      locations.map((location) => location.contentKind).sort(),
      [
        "assistant",
        "reasoning",
        "tool",
        "user",
      ],
    );
    assert.ok(
      locations.every(
        (location) =>
          location.availability === "located" &&
          location.sourcePath !== null,
      ),
    );
  });

  it("uses the verified V2 runtime profile for TRAE CN 3.3.104", () => {
    const userDataPath = createTraeDataRoot();
    const result = probeMessageSources(userDataPath, "3.3.104");

    assert.strictEqual(result.profileId, "trae-cn-runtime-v2");
    assert.strictEqual(result.profileVerification, "verified");
    assert.ok(
      result.locations.every(
        (location) => location.evidenceLevel === "runtime-readback",
      ),
    );
    assert.deepStrictEqual(result.runtimeReadPath, {
      serviceMethod: "TraeApi.chat.getMessages",
      endpoint: "lite/get_messages",
      environment: "local",
      evidenceLevel: "runtime-readback",
      evidenceFixture: "trae-cn-3.3.104.structured-runtime.json",
    });
  });

  it("fails closed for an unmapped product version", () => {
    const userDataPath = createTraeDataRoot();
    const result = probeMessageSources(userDataPath, "3.4.0");

    assert.strictEqual(result.profileId, "unknown");
    assert.strictEqual(result.profileVerification, "unsupported");
    assert.strictEqual(result.runtimeReadPath, null);
    assert.ok(
      result.locations.every(
        (location) =>
          location.availability === "unknown" &&
          location.sourcePath === null &&
          location.evidenceLevel === "unverified",
      ),
    );
  });

  it("matches the checked-in TRAE CN 3.3.104 mapping fixture", () => {
    const fixturePath = path.join(
      process.cwd(),
      "fixtures",
      "source-locations",
      "trae-cn-3.3.104.json",
    );
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
      profileVerification: string;
      locations: Array<{
        contentKind: string;
        availability: string;
        sourcePath: string | null;
        fields: string[];
        evidenceLevel: string;
      }>;
      verification: {
        rowSampled: boolean;
        runtimeReadback: boolean;
        status: string;
        runtimeEvidenceFixture: string;
        structuredRuntimeEvidenceFixture: string;
        reason: string;
      };
    };
    const locations = getMessageSourceLocations().map((location) => ({
      contentKind: location.contentKind,
      availability: location.availability,
      sourcePath: location.sourcePath,
      fields: location.fields,
      evidenceLevel: location.evidenceLevel,
    }));

    assert.deepStrictEqual(locations, fixture.locations);
    assert.strictEqual(fixture.profileVerification, "verified");
    assert.deepStrictEqual(fixture.verification, {
      rowSampled: false,
      runtimeReadback: true,
      status: "verified",
      runtimeEvidenceFixture: "trae-cn-3.3.104.runtime.json",
      structuredRuntimeEvidenceFixture:
        "trae-cn-3.3.104.structured-runtime.json",
      reason:
        "A real V2 TraeApi.chat.getMessages readback verifies message text, reasoning, tool payloads, relationships, status, and timing. The physical database remains opaque and is not a production source.",
    });
  });

  it("validates the checked-in structured runtime evidence", () => {
    const fixturePath = path.join(
      process.cwd(),
      "fixtures",
      "source-locations",
      "trae-cn-3.3.104.structured-runtime.json",
    );
    const serialized = fs.readFileSync(fixturePath, "utf8");
    const fixture = validateTraeStructuredRuntimeEvidence(
      JSON.parse(serialized),
    );

    assert.strictEqual(fixture.verification.status, "verified");
    assert.strictEqual(fixture.counts.messages, 50);
    assert.deepStrictEqual(fixture.counts.roles, {
      assistant: 25,
      user: 25,
    });
    assert.strictEqual(fixture.relationship.matches, 25);
    assert.strictEqual(
      fixture.textEvidence["planItem.reasoning_content"].nonEmpty,
      270,
    );
    assert.strictEqual(fixture.counts.toolCalls, 1218);
    assert.strictEqual(fixture.toolSamples.length, 20);
    assert.strictEqual(
      fixture.capture.sourceArtifactSha256,
      "sha256:987c8512e60ebb1d9fd575d24b204c746f6ad000536c57587da1882c4c4f6e3a",
    );

    for (const forbidden of [
      "/Users/",
      "\"message_id\":",
      "\"turn_id\":",
      "\"reply_to_message_id\":",
      "\"params\":",
      "\"result\":",
      "output_path",
      "account_id",
    ]) {
      assert.ok(!serialized.includes(forbidden), `leaked ${forbidden}`);
    }
  });

  it("keeps legacy runtime-log evidence partial and free of private values", () => {
    const fixturePath = path.join(
      process.cwd(),
      "fixtures",
      "source-locations",
      "trae-cn-3.3.104.runtime.json",
    );
    const serialized = fs.readFileSync(fixturePath, "utf8");
    const fixture = JSON.parse(serialized) as {
      verification: { status: string; sessionHash: string };
      turns: {
        replyAssociationVerified: boolean;
        turnAssociationVerified: boolean;
        samples: Array<{
          assistantMessageHash: string;
          userMessageHash: string;
          turnHash: string;
          relationVerified: boolean;
        }>;
      };
      tools: {
        sampledCalls: number;
        pairedCalls: number;
        unpairedCalls: number;
      };
      privacy: {
        messageContentIncluded: boolean;
        rawIdentifiersIncluded: boolean;
        absolutePathsIncluded: boolean;
        accountDataIncluded: boolean;
      };
      evidenceSha256: string;
    };

    assert.strictEqual(fixture.verification.status, "partial");
    assert.match(fixture.verification.sessionHash, /^sha256:[a-f0-9]{64}$/);
    assert.strictEqual(fixture.turns.replyAssociationVerified, true);
    assert.strictEqual(fixture.turns.turnAssociationVerified, true);
    assert.ok(
      fixture.turns.samples.every(
        (sample) =>
          sample.relationVerified &&
          [sample.assistantMessageHash, sample.userMessageHash, sample.turnHash]
            .every((value) => /^sha256:[a-f0-9]{64}$/.test(value)),
      ),
    );
    assert.ok(fixture.tools.sampledCalls > 0);
    assert.strictEqual(fixture.tools.pairedCalls, fixture.tools.sampledCalls);
    assert.strictEqual(fixture.tools.unpairedCalls, 0);
    assert.deepStrictEqual(fixture.privacy, {
      messageContentIncluded: false,
      rawIdentifiersIncluded: false,
      absolutePathsIncluded: false,
      accountDataIncluded: false,
    });

    const { evidenceSha256, ...reportWithoutDigest } = fixture;
    const actualDigest = `sha256:${
      crypto.createHash("sha256")
        .update(JSON.stringify(reportWithoutDigest))
        .digest("hex")
    }`;
    assert.strictEqual(evidenceSha256, actualDigest);

    for (const forbidden of [
      "/Users/",
      "user_message_context",
      "\"query\"",
      "output_path",
      "account_id",
    ]) {
      assert.ok(!serialized.includes(forbidden), `leaked ${forbidden}`);
    }
  });
});
