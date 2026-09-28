import assert from "node:assert/strict";
import * as fs from "node:fs/promises";

interface PackageMetadata {
  name?: unknown;
  version?: unknown;
  packages?: Record<string, { version?: unknown }>;
}

interface ReleasePleaseConfig {
  "bootstrap-sha"?: unknown;
  packages?: Record<string, {
    "release-type"?: unknown;
    "include-component-in-tag"?: unknown;
    "include-v-in-tag"?: unknown;
    "extra-files"?: Array<{ type?: unknown; path?: unknown }>;
  }>;
}

const readJson = async <T>(filename: string): Promise<T> =>
  JSON.parse(await fs.readFile(filename, "utf8")) as T;

const packageJson = await readJson<PackageMetadata>("package.json");
const packageLock = await readJson<PackageMetadata>("package-lock.json");
const releaseManifest = await readJson<Record<string, unknown>>(".release-please-manifest.json");
const releaseConfig = await readJson<ReleasePleaseConfig>("release-please-config.json");
const website = await fs.readFile("website/index.html", "utf8");
const changelog = await fs.readFile("CHANGELOG.md", "utf8");
const releaseWorkflow = await fs.readFile(".github/workflows/release-please.yml", "utf8");

assert.equal(packageJson.name, "trae2opencode");
assert.match(String(packageJson.version), /^\d+\.\d+\.\d+$/);
const version = String(packageJson.version);

assert.equal(packageLock.version, version, "package-lock.json top-level version differs");
assert.equal(packageLock.packages?.[""]?.version, version, "package-lock.json root package differs");
assert.equal(releaseManifest["."], version, "release-please manifest version differs");

const softwareVersion = /"softwareVersion"\s*:\s*"([^"]+)"/.exec(website)?.[1];
const visibleVersion = /data-product-version[^>]*>\s*v([^<\s]+)\s*</.exec(website)?.[1];
assert.equal(softwareVersion, version, "Website structured product version differs");
assert.equal(visibleVersion, version, "Website visible product version differs");
assert.match(website, /x-release-please-start-version[\s\S]+x-release-please-end/);
assert.match(website, /data-product-version[^>]*>[^<]+<\/span><!-- x-release-please-version -->/);

const escapedVersion = version.replaceAll(".", "\\.");
assert.match(changelog, new RegExp(
  `^## \\[${escapedVersion}\\](?:\\([^\\n]+\\))?(?: - | \\()\\d{4}-\\d{2}-\\d{2}\\)?$`,
  "m",
));
assert.doesNotMatch(changelog, /^## \[[^\]]+\].*Unreleased$/m);

const rootRelease = releaseConfig.packages?.["."];
assert.equal(rootRelease?.["release-type"], "node");
assert.equal(rootRelease?.["include-component-in-tag"], false);
assert.equal(rootRelease?.["include-v-in-tag"], true);
assert.ok(rootRelease?.["extra-files"]?.some(
  (file) => file.type === "generic" && file.path === "website/index.html",
));
assert.match(String(releaseConfig["bootstrap-sha"]), /^[a-f0-9]{40}$/);
assert.match(releaseWorkflow,
  /googleapis\/release-please-action@5c625bfb5d1ff62eadeeb3772007f7f66fdcf071/);
assert.match(releaseWorkflow,
  /gh workflow run quality\.yml --repo "\$GITHUB_REPOSITORY" --ref "\$branch"/);

const releaseTag = process.env.T2O_RELEASE_TAG?.trim();
if (releaseTag) assert.equal(releaseTag, `v${version}`, "Release tag differs from package version");

console.log(`Product version ${version} is consistent.`);
