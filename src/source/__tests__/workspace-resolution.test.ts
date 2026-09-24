import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  normalizeWorkspaceFileUri,
  resolveTraeWorkspaces,
  resolveWorkspaceLocation,
} from "../trae/workspace-resolution.js";

const temporaryDirectories: string[] = [];
const nativePlatform = process.platform === "win32" ? "win32" : "darwin";

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "trae-workspace-resolution-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function writeWorkspaceMetadata(
  workspaceStoragePath: string,
  workspaceStorageId: string,
  metadata: unknown,
): string {
  const workspaceDirectory = path.join(
    workspaceStoragePath,
    workspaceStorageId,
  );
  fs.mkdirSync(workspaceDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDirectory, "workspace.json"),
    JSON.stringify(metadata),
  );
  return workspaceDirectory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("normalizeWorkspaceFileUri", () => {
  it("decodes and normalizes a macOS file URI", () => {
    assert.equal(
      normalizeWorkspaceFileUri(
        "file:///Users/tester/My%20Project/../Project",
        "darwin",
      ),
      "/Users/tester/Project",
    );
  });

  it("normalizes a Windows drive URI independently of the host", () => {
    assert.equal(
      normalizeWorkspaceFileUri(
        "file:///C%3A/Users/tester/My%20Project",
        "win32",
      ),
      "C:\\Users\\tester\\My Project",
    );
  });

  it("normalizes a Windows UNC file URI", () => {
    assert.equal(
      normalizeWorkspaceFileUri(
        "file://server/share/My%20Project",
        "win32",
      ),
      "\\\\server\\share\\My Project",
    );
  });

  it("rejects remote and separator-encoded URIs", () => {
    for (const uri of [
      "vscode-remote://ssh-remote+host/project",
      "file:///Users/tester/project%2Fsecret",
    ]) {
      assert.throws(
        () => normalizeWorkspaceFileUri(uri, "darwin"),
        (error) => {
          assert.ok(error instanceof Trae2OpenCodeError);
          assert.equal(error.code, "T2O_TRAE_WORKSPACE_URI_UNSUPPORTED");
          assert.doesNotMatch(error.message, /tester|secret|host/);
          return true;
        },
      );
    }
  });
});

describe("resolveWorkspaceLocation", () => {
  it("distinguishes folder and workspace metadata", () => {
    assert.deepStrictEqual(
      resolveWorkspaceLocation(
        { folder: "file:///Users/tester/project" },
        "darwin",
      ),
      {
        kind: "folder",
        path: "/Users/tester/project",
      },
    );
    assert.deepStrictEqual(
      resolveWorkspaceLocation(
        { workspace: "file:///Users/tester/project.code-workspace" },
        "darwin",
      ),
      {
        kind: "workspace",
        path: "/Users/tester/project.code-workspace",
      },
    );
  });

  it("rejects ambiguous metadata", () => {
    assert.throws(
      () =>
        resolveWorkspaceLocation(
          {
            folder: "file:///Users/tester/project",
            workspace: "file:///Users/tester/project.code-workspace",
          },
          "darwin",
        ),
      (error) => {
        assert.ok(error instanceof Trae2OpenCodeError);
        assert.equal(error.code, "T2O_TRAE_WORKSPACE_METADATA_INVALID");
        return true;
      },
    );
  });
});

describe("resolveTraeWorkspaces", () => {
  it("resolves a folder workspace to one project", () => {
    const root = createTemporaryDirectory();
    const workspaceStoragePath = path.join(root, "workspaceStorage");
    const projectPath = path.join(root, "project");
    fs.mkdirSync(projectPath);
    writeWorkspaceMetadata(workspaceStoragePath, "workspace-b", {
      folder: pathToFileURL(projectPath).href,
    });

    const report = resolveTraeWorkspaces({
      platform: nativePlatform,
      workspaceStoragePath,
    });

    assert.deepStrictEqual(report.issues, []);
    assert.equal(report.workspaces.length, 1);
    assert.deepStrictEqual(report.workspaces[0].location, {
      kind: "folder",
      path: projectPath,
      exists: true,
    });
    assert.deepStrictEqual(report.workspaces[0].projects, [
      {
        path: projectPath,
        source: "folder-uri",
        exists: true,
      },
    ]);
  });

  it("parses JSONC multi-root workspaces and deduplicates projects", () => {
    const root = createTemporaryDirectory();
    const workspaceStoragePath = path.join(root, "workspaceStorage");
    const workspaceFilePath = path.join(root, "team.code-workspace");
    const firstProjectPath = path.join(root, "packages", "first");
    const secondProjectPath = path.join(root, "packages", "second");
    fs.mkdirSync(firstProjectPath, { recursive: true });
    fs.mkdirSync(secondProjectPath, { recursive: true });
    fs.writeFileSync(
      workspaceFilePath,
      `{
        // VS Code workspace files use JSON with comments.
        "folders": [
          { "path": "packages/first" },
          { "uri": "${pathToFileURL(secondProjectPath).href}" },
          { "path": "packages/first" },
        ],
      }`,
    );
    writeWorkspaceMetadata(workspaceStoragePath, "workspace-a", {
      workspace: pathToFileURL(workspaceFilePath).href,
    });

    const report = resolveTraeWorkspaces({
      platform: nativePlatform,
      workspaceStoragePath,
    });

    assert.deepStrictEqual(report.issues, []);
    assert.deepStrictEqual(report.workspaces[0].projects, [
      {
        path: firstProjectPath,
        source: "workspace-folder-path",
        exists: true,
      },
      {
        path: secondProjectPath,
        source: "workspace-folder-uri",
        exists: true,
      },
    ]);
  });

  it("retains a workspace record when its configuration is missing", () => {
    const root = createTemporaryDirectory();
    const workspaceStoragePath = path.join(root, "workspaceStorage");
    const missingWorkspacePath = path.join(root, "missing.code-workspace");
    writeWorkspaceMetadata(workspaceStoragePath, "workspace-a", {
      workspace: pathToFileURL(missingWorkspacePath).href,
    });

    const report = resolveTraeWorkspaces({
      platform: nativePlatform,
      workspaceStoragePath,
    });

    assert.equal(report.workspaces.length, 1);
    assert.equal(report.workspaces[0].location.exists, false);
    assert.deepStrictEqual(report.workspaces[0].projects, []);
    assert.deepStrictEqual(
      report.issues.map((issue) => issue.code),
      ["T2O_TRAE_WORKSPACE_CONFIG_NOT_FOUND"],
    );
    assert.equal(JSON.stringify(report.issues).includes(root), false);
  });

  it("continues after missing and invalid workspace metadata", () => {
    const root = createTemporaryDirectory();
    const workspaceStoragePath = path.join(root, "workspaceStorage");
    const projectPath = path.join(root, "valid-project");
    fs.mkdirSync(
      path.join(workspaceStoragePath, "workspace-a"),
      { recursive: true },
    );
    const invalidDirectory = writeWorkspaceMetadata(
      workspaceStoragePath,
      "workspace-b",
      { folder: 42 },
    );
    fs.writeFileSync(
      path.join(invalidDirectory, "workspace.json"),
      "{ invalid",
    );
    fs.mkdirSync(projectPath);
    writeWorkspaceMetadata(workspaceStoragePath, "workspace-c", {
      folder: pathToFileURL(projectPath).href,
    });

    const report = resolveTraeWorkspaces({
      platform: nativePlatform,
      workspaceStoragePath,
    });

    assert.deepStrictEqual(
      report.workspaces.map((workspace) => workspace.workspaceStorageId),
      ["workspace-c"],
    );
    assert.deepStrictEqual(
      report.issues.map((issue) => [
        issue.workspaceStorageId,
        issue.code,
      ]),
      [
        ["workspace-a", "T2O_TRAE_WORKSPACE_METADATA_NOT_FOUND"],
        ["workspace-b", "T2O_TRAE_WORKSPACE_METADATA_INVALID"],
      ],
    );
  });

  it("keeps valid workspace folders when another entry is invalid", () => {
    const root = createTemporaryDirectory();
    const workspaceStoragePath = path.join(root, "workspaceStorage");
    const workspaceFilePath = path.join(root, "team.code-workspace");
    const projectPath = path.join(root, "project");
    fs.mkdirSync(projectPath);
    fs.writeFileSync(
      workspaceFilePath,
      JSON.stringify({
        folders: [
          { path: "project" },
          { uri: "vscode-remote://ssh-remote+host/project" },
        ],
      }),
    );
    writeWorkspaceMetadata(workspaceStoragePath, "workspace-a", {
      workspace: pathToFileURL(workspaceFilePath).href,
    });

    const report = resolveTraeWorkspaces({
      platform: nativePlatform,
      workspaceStoragePath,
    });

    assert.equal(report.workspaces[0].projects.length, 1);
    assert.equal(report.workspaces[0].projects[0].path, projectPath);
    assert.deepStrictEqual(report.issues[0], {
      code: "T2O_TRAE_WORKSPACE_URI_UNSUPPORTED",
      severity: "error",
      workspaceStorageId: "workspace-a",
      entryIndex: 1,
      message: "TRAE workspace URI is unsupported.",
    });
  });

  it("returns an empty report when workspace storage is absent", () => {
    const root = createTemporaryDirectory();

    assert.deepStrictEqual(
      resolveTraeWorkspaces({
        platform: nativePlatform,
        workspaceStoragePath: path.join(root, "missing"),
      }),
      {
        workspaces: [],
        issues: [],
      },
    );
  });
});
