import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  canonicalizeMigrationBundle,
  hashCanonicalJson,
  hashMigrationBundle,
  parseCanonicalMigrationBundle,
} from "../canonical.js";
import { migrationBundleSchema } from "../schema.js";
import type { JsonValue } from "../types.js";

interface GoldenManifest {
  goldenVersion: number;
  schemaVersion: number;
  schemaSha256: string;
  cases: Array<{
    name: string;
    source: string;
    golden: string;
    sha256: string;
  }>;
}

const repositoryRoot = process.cwd();
const fixtureRoot = path.join(repositoryRoot, "fixtures", "ir", "v1");
const goldenRoot = path.join(fixtureRoot, "golden");

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readManifest(): GoldenManifest {
  return readJson(
    path.join(goldenRoot, "manifest.json"),
  ) as GoldenManifest;
}

describe("IR golden fixtures", () => {
  it("matches every valid fixture without updating files", () => {
    const sourceNames = fs
      .readdirSync(fixtureRoot)
      .filter((name) => /^valid-.*\.json$/.test(name))
      .sort();
    const goldenNames = fs
      .readdirSync(goldenRoot)
      .filter((name) => /^valid-.*\.json$/.test(name))
      .sort();
    const manifest = readManifest();

    assert.equal(manifest.goldenVersion, 1);
    assert.equal(manifest.schemaVersion, 1);
    assert.deepStrictEqual(goldenNames, sourceNames);
    assert.equal(
      manifest.schemaSha256,
      hashCanonicalJson(migrationBundleSchema as unknown as JsonValue),
      "IR Schema changed; review it, then run " +
        "`npm run golden:update -- --accept`",
    );
    assert.deepStrictEqual(
      manifest.cases.map((item) => path.basename(item.source)),
      sourceNames,
    );

    for (const goldenCase of manifest.cases) {
      const source = readJson(path.join(repositoryRoot, goldenCase.source));
      const expected = fs.readFileSync(
        path.join(repositoryRoot, goldenCase.golden),
        "utf8",
      );
      const actual = canonicalizeMigrationBundle(source);

      assert.equal(
        actual,
        expected,
        `${goldenCase.name} changed; review the IR diff, then run ` +
          "`npm run golden:update -- --accept`",
      );
      assert.equal(hashMigrationBundle(source), goldenCase.sha256);
      assert.equal(
        canonicalizeMigrationBundle(
          parseCanonicalMigrationBundle(expected),
        ),
        expected,
      );
    }
  });

  it("sorts object keys while preserving event order", () => {
    const fixture = readJson(
      path.join(fixtureRoot, "valid-complete.json"),
    ) as Record<string, unknown>;
    const reorderedRoot = Object.fromEntries(
      Object.entries(fixture).reverse(),
    );

    assert.equal(
      canonicalizeMigrationBundle(reorderedRoot),
      canonicalizeMigrationBundle(fixture),
    );

    const reorderedEvents = structuredClone(fixture) as {
      sessions: Array<{ events: unknown[] }>;
    };
    reorderedEvents.sessions[0].events.reverse();
    assert.notEqual(
      hashMigrationBundle(reorderedEvents),
      hashMigrationBundle(fixture),
    );
  });

  it("refuses accidental golden updates", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repositoryRoot, "scripts", "update-golden-fixtures.ts"),
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /explicit --accept/);
  });
});
