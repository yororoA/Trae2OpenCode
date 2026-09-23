import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { assertResourcePath, inspectResourceFile } from "../trae/resource-file.js";

const directories: string[] = [];
function directory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t2o-resource-"));
  directories.push(root);
  return root;
}
afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("inspectResourceFile", () => {
  it("hashes large UTF-8 content with a multibyte character spanning chunks", () => {
    const root = directory();
    const file = path.join(root, "body.txt");
    const bytes = Buffer.from(`${"a".repeat(65535)}中${"文".repeat(100000)}`);
    fs.writeFileSync(file, bytes);
    assert.deepEqual(inspectResourceFile(root, file, true), {
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      sizeBytes: bytes.length,
      mimeType: "text/plain",
    });
    assert.deepEqual(fs.readFileSync(file), bytes);
  });

  it("detects binary signatures and rejects invalid or incomplete UTF-8 long text", () => {
    const root = directory();
    const file = path.join(root, "misleading.txt");
    fs.writeFileSync(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    assert.equal(inspectResourceFile(root, file).mimeType, "image/png");
    assert.throws(() => inspectResourceFile(root, file, true));
    fs.writeFileSync(file, Buffer.from([0xe4, 0xb8]));
    assert.equal(inspectResourceFile(root, file).mimeType, "application/octet-stream");
    assert.throws(() => inspectResourceFile(root, file, true));
    fs.writeFileSync(file, Buffer.from([0]));
    assert.equal(inspectResourceFile(root, file).mimeType, "application/octet-stream");
  });

  it("rejects outside paths, symlink files, symlink parents, and directories", () => {
    const root = directory();
    const outside = directory();
    const file = path.join(outside, "private.txt");
    fs.writeFileSync(file, "outside data");
    fs.symlinkSync(file, path.join(root, "link.txt"));
    fs.symlinkSync(outside, path.join(root, "linked-directory"), "dir");
    assert.throws(() => assertResourcePath(root, file));
    assert.throws(() => inspectResourceFile(root, path.join(root, "link.txt")));
    assert.throws(() => inspectResourceFile(root, path.join(root, "linked-directory", "private.txt")));
    fs.mkdirSync(path.join(root, "directory"));
    assert.throws(() => inspectResourceFile(root, path.join(root, "directory")));
  });
});
