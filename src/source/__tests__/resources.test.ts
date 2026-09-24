import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { requireTraeRoot } from "../trae/path-discovery.js";
import { scanTraeResources } from "../trae/resources.js";
import { parseTraeQueryCache } from "../trae/user-messages.js";

const directories: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=", "base64");
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t2o-attachments-"));
  directories.push(directory);
  fs.mkdirSync(path.join(directory, "User", "workspaceStorage"), { recursive: true });
  const root = requireTraeRoot({
    traeRoot: directory, platform: process.platform === "win32" ? "win32" : "darwin",
  });
  const write = (workspace: string, relative: string, content: string | Buffer) => {
    const file = path.join(root.workspaceStoragePath, workspace, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { root, write };
}
afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("scanTraeResources", () => {
  it("retains image and long-text hashes and associates only exact references", () => {
    const { root, write } = setup();
    const image = write("workspace-a", "paste-files/image with space.png", png);
    write("workspace-a", "long-text/scope/entry/body.txt", "long text body");
    write("workspace-b", "paste-files/image with space.png", png);
    const reference = {
      workspaceStorageId: "workspace-a",
      path: pathToFileURL(image).href,
      sourceSessionId: "session-example",
      sourceMessageId: "message-user",
    };
    const report = scanTraeResources(root, "3.3.104", [], [reference, reference]);
    const resource = report.resources.find((item) => item.workspaceStorageId === "workspace-a" && item.type === "image");
    assert.ok(resource);
    assert.equal(resource.availability, "available");
    assert.equal(resource.mimeType, "image/png");
    assert.equal(resource.sizeBytes, png.length);
    assert.match(resource.sha256 ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.equal(resource.references[0].sourceSessionId, "session-example");
    assert.equal(report.resources.find((item) => item.workspaceStorageId === "workspace-b")?.references.length, 0);
    assert.equal(report.resources.find((item) => item.type === "long-text")?.mimeType, "text/plain");
    assert.equal(report.resources.length, 3);
    assert.doesNotMatch(JSON.stringify(report.issues), /image with space|long text body|file:\/|\/Users\//);
  });

  it("records missing local resources and deferred opaque or remote references", () => {
    const { root } = setup();
    const entries = parseTraeQueryCache([{
      inputText: "", parsedQuery: [], multiMedia: [{ resource_id: "opaque-private-id", resource_type: "image" }],
      files: [{
        id: "file-remote", name: "private.png", size: 10, type: "image/png",
        resourceUri: "https://private.invalid/image?token=secret", kind: "image",
      }],
    }], "workspace-a", "3.3.104").queryCacheEntries;
    const report = scanTraeResources(root, "3.3.104", entries, [{
      workspaceStorageId: "workspace-a", path: "paste-files/missing.png", sourceSessionId: "session-example",
    }]);
    assert.deepEqual(report.resources.map((item) => item.availability).sort(), ["deferred", "deferred", "missing"]);
    assert.ok(report.resources.every((item) => item.sha256 === undefined && item.sizeBytes === undefined));
    assert.ok(report.issues.some((item) => item.code === "T2O_TRAE_RESOURCE_MISSING"));
    assert.doesNotMatch(JSON.stringify(report), /private\.invalid|opaque-private-id|token=secret/);
  });

  it("retains cache provenance without inferring a session and reports metadata disagreement", () => {
    const { root, write } = setup();
    const file = write("workspace-a", "paste-files/image.png", png);
    const entries = parseTraeQueryCache([{
      inputText: "private prompt", parsedQuery: [{ filePath: file }], multiMedia: [],
      files: [{
        id: "image-id", name: "image.png", size: 1, type: "application/pdf", resourceUri: file, kind: "image",
      }],
    }], "workspace-a", "3.3.104").queryCacheEntries;
    const report = scanTraeResources(root, "3.3.104", entries);
    assert.equal(report.resources.length, 1);
    assert.equal(report.resources[0].references.length, 2);
    assert.ok(report.resources[0].references.every((item) => item.sourceSessionId === undefined));
    assert.equal(report.resources[0].mimeType, "image/png");
    assert.ok(report.issues.some((item) => item.code === "T2O_TRAE_RESOURCE_METADATA_MISMATCH"));
    assert.ok(report.issues.some((item) => item.code === "T2O_TRAE_RESOURCE_UNASSOCIATED"));
    assert.doesNotMatch(JSON.stringify(report.issues), /private prompt|image.png/);
  });

  it("rejects cross-workspace, basename, traversal, and symlink references", () => {
    const { root, write } = setup();
    const other = write("workspace-b", "paste-files/same.png", png);
    const anchor = write("workspace-a", "paste-files/real.png", png);
    fs.symlinkSync(other, path.join(path.dirname(anchor), "link.png"));
    const references = [
      { workspaceStorageId: "workspace-a", path: other },
      { workspaceStorageId: "workspace-a", path: "same.png" },
      { workspaceStorageId: "workspace-a", path: "../workspace-b/paste-files/same.png" },
      { workspaceStorageId: "..", path: other },
      { workspaceStorageId: "workspace-a", path: "paste-files/link.png" },
    ];
    const report = scanTraeResources(root, "3.3.104", [], references);
    const link = report.resources.find((item) => item.relativePath === "paste-files/link.png");
    assert.equal(link?.availability, "deferred");
    assert.equal(link?.sha256, undefined);
    assert.ok(report.resources.filter((item) => item.availability === "available").every((item) => item.references.length === 0));
    assert.equal(report.issues.filter((item) => item.code === "T2O_TRAE_RESOURCE_REFERENCE_INVALID").length, 4);
  });

  it("rejects directory symlinks, classifies unknown bytes, and fails closed on version", () => {
    const { root, write } = setup();
    const file = write("workspace-a", "paste-files/binary.bin", Buffer.from([0, 255, 254]));
    fs.mkdirSync(path.join(root.workspaceStoragePath, "workspace-b"));
    fs.symlinkSync(path.dirname(file), path.join(root.workspaceStoragePath, "workspace-b", "paste-files"), "dir");
    const report = scanTraeResources(root, "3.3.104");
    assert.equal(report.resources.length, 1);
    assert.equal(report.resources[0].mimeType, "application/octet-stream");
    assert.ok(report.issues.some((item) => item.code === "T2O_TRAE_RESOURCE_SCAN_FAILED"));
    assert.ok(report.issues.some((item) => item.code === "T2O_TRAE_RESOURCE_MIME_UNKNOWN"));
    assert.throws(() => scanTraeResources(root, "3.3.105"), { code: "T2O_TRAE_RESOURCE_VERSION_UNSUPPORTED" });
  });
});
