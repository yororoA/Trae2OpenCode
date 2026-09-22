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

  it("keeps current TRAE CN evidence below row-level verification", () => {
    const userDataPath = createTraeDataRoot();
    const result = probeMessageSources(userDataPath, "3.3.104");

    assert.strictEqual(result.profileVerification, "unverified");
    assert.ok(
      result.locations.every(
        (location) => location.evidenceLevel === "schema-observed",
      ),
    );
    assert.deepStrictEqual(result.runtimeReadPath, {
      serviceMethod: "_aiAgentChatService.getSessionMessages",
      endpoint: "lite/get_messages",
      evidenceLevel: "schema-observed",
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
      locations: Array<{
        contentKind: string;
        availability: string;
        sourcePath: string | null;
        fields: string[];
        evidenceLevel: string;
      }>;
    };
    const locations = getMessageSourceLocations().map((location) => ({
      contentKind: location.contentKind,
      availability: location.availability,
      sourcePath: location.sourcePath,
      fields: location.fields,
      evidenceLevel: location.evidenceLevel,
    }));

    assert.deepStrictEqual(locations, fixture.locations);
  });
});
