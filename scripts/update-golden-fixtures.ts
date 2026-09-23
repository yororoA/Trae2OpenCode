import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalizeJson,
  canonicalizeMigrationBundle,
  hashCanonicalJson,
  hashMigrationBundle,
} from "../src/ir/canonical.js";
import { migrationBundleSchema } from "../src/ir/schema.js";
import type { JsonValue } from "../src/ir/types.js";
import { assembleTraeMigrationBundle } from "../src/source/trae/assemble-bundle.js";

if (!process.argv.slice(2).includes("--accept")) {
  process.stderr.write(
    "Refusing to update golden fixtures without explicit --accept.\n",
  );
  process.exitCode = 2;
} else {
  const fixtureRoot = path.join(process.cwd(), "fixtures", "ir", "v1");
  const goldenRoot = path.join(fixtureRoot, "golden");
  const assemblyInput = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "fixtures/source/trae-cn-3.3.104/assembly.json"), "utf8",
  ));
  fs.writeFileSync(
    path.join(fixtureRoot, "valid-trae-assembled.json"),
    canonicalizeMigrationBundle(assembleTraeMigrationBundle(assemblyInput)),
    "utf8",
  );
  const sourceFiles = fs
    .readdirSync(fixtureRoot)
    .filter((name) => /^valid-.*\.json$/.test(name))
    .sort();

  if (sourceFiles.length === 0) {
    throw new Error("No valid IR fixtures were found");
  }

  fs.mkdirSync(goldenRoot, { recursive: true });

  const cases = sourceFiles.map((name) => {
    const sourcePath = path.join(fixtureRoot, name);
    const value = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    const canonical = canonicalizeMigrationBundle(value);
    fs.writeFileSync(path.join(goldenRoot, name), canonical, "utf8");

    return {
      name: name.replace(/\.json$/, ""),
      source: `fixtures/ir/v1/${name}`,
      golden: `fixtures/ir/v1/golden/${name}`,
      sha256: hashMigrationBundle(value),
    };
  });

  const generatedFiles = new Set([
    ...sourceFiles,
    "manifest.json",
  ]);
  for (const name of fs.readdirSync(goldenRoot)) {
    const isStaleJson =
      name.endsWith(".json") &&
      !generatedFiles.has(name);
    if (isStaleJson) {
      fs.rmSync(path.join(goldenRoot, name));
    }
  }

  const manifest = {
    goldenVersion: 1,
    schemaVersion: 1,
    schemaSha256: hashCanonicalJson(
      migrationBundleSchema as unknown as JsonValue,
    ),
    cases,
  };
  fs.writeFileSync(
    path.join(goldenRoot, "manifest.json"),
    canonicalizeJson(manifest as unknown as JsonValue),
    "utf8",
  );
  process.stdout.write(`Updated ${cases.length} IR golden fixture(s).\n`);
}
