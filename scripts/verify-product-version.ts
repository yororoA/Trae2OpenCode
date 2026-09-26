import assert from "node:assert/strict";
import * as fs from "node:fs/promises";

interface PackageMetadata {
  name?: unknown;
  version?: unknown;
  packages?: Record<string, { version?: unknown }>;
}

const readJson = async (filename: string): Promise<PackageMetadata> =>
  JSON.parse(await fs.readFile(filename, "utf8")) as PackageMetadata;

const packageJson = await readJson("package.json");
const packageLock = await readJson("package-lock.json");
const website = await fs.readFile("website/index.html", "utf8");
const changelog = await fs.readFile("CHANGELOG.md", "utf8");

assert.equal(packageJson.name, "trae2opencode");
assert.match(String(packageJson.version), /^\d+\.\d+\.\d+$/);
const version = String(packageJson.version);

assert.equal(packageLock.version, version, "package-lock.json top-level version differs");
assert.equal(packageLock.packages?.[""]?.version, version, "package-lock.json root package differs");

const softwareVersion = /"softwareVersion"\s*:\s*"([^"]+)"/.exec(website)?.[1];
const visibleVersion = /data-product-version[^>]*>\s*v([^<\s]+)\s*</.exec(website)?.[1];
assert.equal(softwareVersion, version, "Website structured product version differs");
assert.equal(visibleVersion, version, "Website visible product version differs");
const unreleasedHeading = "## [Unreleased]";
const versionHeading = new RegExp(
  `^## \\[${version.replaceAll(".", "\\.")}\\] - (?:Unreleased|\\d{4}-\\d{2}-\\d{2})$`,
  "m",
);
assert.match(changelog, /^## \[Unreleased\]$/m, "Changelog is missing its next-release section");
const versionMatch = versionHeading.exec(changelog);
assert.ok(versionMatch, "Changelog is missing the current product version");
assert.ok(
  changelog.indexOf(unreleasedHeading) < versionMatch.index,
  "Unreleased changes must precede the current product release",
);

console.log(`Product version ${version} is consistent.`);
