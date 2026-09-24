/** Install the actual tarball away from repository dependencies and run its CLI. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = process.cwd();
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run through npm run verify:package");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "t2o package 中文 "));
const schema = "fixtures/opencode/2.0.12/evidence/transfer.schema.json";
const sample = "fixtures/ir/v1/valid-trae-assembled.json";
const npm = async (args: string[], cwd: string) => {
  const result = await exec(process.execPath, [npmCli, ...args], {
    cwd, timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
  });
  return result.stdout;
};
try {
  const packed = JSON.parse(await npm([
    "pack", "--json", "--pack-destination", temporary,
  ], repository)) as Array<{
    filename: string; size: number; unpackedSize: number;
    files: Array<{ path: string }>;
  }>;
  assert.equal(packed.length, 1);
  const artifact = packed[0];
  const files = artifact.files.map((file) => file.path);
  for (const required of ["package.json", "README.md", "LICENSE", "dist/cli/index.js", schema, sample]) {
    assert.ok(files.includes(required), `Missing package file: ${required}`);
  }
  for (const file of files) {
    const allowed = file === "package.json" || file === "README.md" || file === "LICENSE" ||
      (file.startsWith("dist/") && file.endsWith(".js") && !file.includes("/__tests__/")) ||
      (file.startsWith("docs/") && file.endsWith(".md")) || file === schema || file === sample;
    assert.ok(allowed, `Unexpected package file: ${file}`);
  }
  const installation = path.join(temporary, "fresh installation");
  await fs.mkdir(installation);
  await fs.writeFile(path.join(installation, "package.json"),
    JSON.stringify({ private: true, name: "t2o-package-smoke", version: "0.0.0" }));
  const tarball = path.join(temporary, artifact.filename);
  await npm(["install", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", tarball], installation);
  const installedPackage = path.join(installation, "node_modules", "trae2opencode");
  assert.equal((await fs.lstat(installedPackage)).isSymbolicLink(), false);
  assert.equal(await fs.realpath(installedPackage),
    path.join(await fs.realpath(installation), "node_modules", "trae2opencode"));
  const cli = (args: string[]) => npm(["exec", "--offline", "--", "trae2opencode", ...args], installation);
  const expectedVersion = JSON.parse(await fs.readFile(path.join(repository, "package.json"), "utf8")).version;
  assert.equal((await cli(["--version"])).trim(), expectedVersion);
  assert.match(await cli(["--help"]), /migrate/);
  const doctor = JSON.parse(await cli([
    "doctor", "--trae-root", path.join(installation, "missing-source"), "--json",
  ]));
  assert.equal(typeof doctor.sqlite.version, "string");
  assert.equal(doctor.trae.available, false);
  const input = path.join(installedPackage, sample);
  const before = await fs.readFile(input);
  const preview = JSON.parse(await cli(["preview", "--input", input, "--json"]));
  assert.equal(preview.sessions.length, 1);
  assert.equal(preview.sessions[0].messageCount, 2);
  const plan = JSON.parse(await cli([
    "migrate", "--input", input, "--dry-run", "--fallback-directory", installation, "--json",
  ]));
  assert.equal(plan.dryRun, true);
  assert.equal(plan.target.probed, false);
  assert.equal(plan.ready, 1);
  assert.equal(plan.blocked, 0);
  assert.equal(plan.excluded, 0);
  assert.deepEqual(plan.sessions[0].expected.counts,
    { messages: 2, users: 1, assistants: 1, text: 2, reasoning: 2, tools: 1 });
  const exported = path.join(installation, "exported");
  await cli(["export", "--input", input, "--output", exported, "--json"]);
  const exportedInput = path.join(exported, "migration-bundle.json");
  const second = JSON.parse(await cli([
    "migrate", "--input", exportedInput, "--dry-run", "--fallback-directory", installation, "--json",
  ]));
  assert.equal(second.irHash, plan.irHash);
  assert.equal(second.sessions[0].transferHash, plan.sessions[0].transferHash);
  assert.deepEqual(await fs.readFile(input), before);
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  assert.equal(hash(await fs.readFile(path.join(installedPackage, schema))),
    hash(await fs.readFile(path.join(repository, schema))));
  const report = {
    platform: process.platform, node: process.version, version: expectedVersion,
    source: "shipped-synthetic-ir", status: "verified", fileCount: files.length,
    packedBytes: artifact.size, unpackedBytes: artifact.unpackedSize,
    tarballSha256: hash(await fs.readFile(tarball)),
    isolatedInstallation: true, cliBin: true, sqlite: doctor.sqlite.version, dryRunReady: plan.ready,
    counts: plan.sessions[0].expected.counts, exportRoundtrip: true, targetProbed: false,
  };
  await fs.mkdir(path.join(repository, "tmp"), { recursive: true });
  await fs.writeFile(path.join(repository, "tmp/m7-4-package-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
