import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import {
  discoverTraeRoot,
  getDefaultTraeUserDataPaths,
  requireTraeRoot,
} from "../trae/path-discovery.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "trae-path-discovery-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("getDefaultTraeUserDataPaths", () => {
  it("lists TRAE CN before TRAE on macOS", () => {
    assert.deepStrictEqual(
      getDefaultTraeUserDataPaths({
        platform: "darwin",
        homeDir: "/Users/tester",
      }),
      [
        "/Users/tester/Library/Application Support/Trae CN/User",
        "/Users/tester/Library/Application Support/Trae/User",
      ],
    );
  });

  it("uses Windows roaming and local application data paths", () => {
    assert.deepStrictEqual(
      getDefaultTraeUserDataPaths({
        platform: "win32",
        homeDir: "C:\\Users\\tester",
        env: {
          APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
          LOCALAPPDATA: "D:\\LocalData",
        },
      }),
      [
        "C:\\Users\\tester\\AppData\\Roaming\\Trae CN\\User",
        "C:\\Users\\tester\\AppData\\Roaming\\Trae\\User",
        "D:\\LocalData\\Trae CN\\User",
        "D:\\LocalData\\Trae\\User",
      ],
    );
  });

  it("derives Windows paths when application data variables are absent", () => {
    assert.deepStrictEqual(
      getDefaultTraeUserDataPaths({
        platform: "win32",
        homeDir: "C:\\Users\\tester",
        env: {},
      }),
      [
        "C:\\Users\\tester\\AppData\\Roaming\\Trae CN\\User",
        "C:\\Users\\tester\\AppData\\Roaming\\Trae\\User",
        "C:\\Users\\tester\\AppData\\Local\\Trae CN\\User",
        "C:\\Users\\tester\\AppData\\Local\\Trae\\User",
      ],
    );
  });

  it("returns no defaults for unsupported platforms", () => {
    assert.deepStrictEqual(
      getDefaultTraeUserDataPaths({
        platform: "linux",
        homeDir: "/home/tester",
      }),
      [],
    );
  });
});

describe("discoverTraeRoot", () => {
  it("prefers a populated default over an earlier empty installation", () => {
    const homeDir = createTemporaryDirectory();
    const emptyCnUser = path.join(
      homeDir,
      "Library",
      "Application Support",
      "Trae CN",
      "User",
    );
    const populatedTraeUser = path.join(
      homeDir,
      "Library",
      "Application Support",
      "Trae",
      "User",
    );
    fs.mkdirSync(emptyCnUser, { recursive: true });
    fs.mkdirSync(path.join(populatedTraeUser, "workspaceStorage"), {
      recursive: true,
    });

    const result = discoverTraeRoot({ platform: "darwin", homeDir });

    assert.ok(result);
    assert.equal(result.product, "trae");
    assert.equal(result.source, "default");
    assert.equal(result.userDataPath, populatedTraeUser);
    assert.deepStrictEqual(result.availability, {
      globalStorage: false,
      workspaceStorage: true,
      modularData: false,
    });
  });

  it("accepts a product directory passed through traeRoot", () => {
    const homeDir = createTemporaryDirectory();
    const productDataPath = path.join(homeDir, "Trae CN");
    fs.mkdirSync(
      path.join(productDataPath, "User", "workspaceStorage"),
      { recursive: true },
    );
    fs.mkdirSync(path.join(productDataPath, "ModularData"), {
      recursive: true,
    });

    const result = discoverTraeRoot({
      traeRoot: productDataPath,
      platform: "darwin",
      homeDir,
    });

    assert.ok(result);
    assert.equal(result.product, "trae-cn");
    assert.equal(result.source, "override");
    assert.equal(result.productDataPath, productDataPath);
    assert.equal(result.userDataPath, path.join(productDataPath, "User"));
    assert.equal(result.availability.modularData, true);
  });

  it("accepts a User directory passed through traeRoot", () => {
    const homeDir = createTemporaryDirectory();
    const userDataPath = path.join(homeDir, "Trae CN", "User");
    fs.mkdirSync(path.join(userDataPath, "globalStorage"), {
      recursive: true,
    });

    const result = discoverTraeRoot({
      traeRoot: userDataPath,
      platform: "darwin",
      homeDir,
    });

    assert.ok(result);
    assert.equal(result.userDataPath, userDataPath);
    assert.equal(result.productDataPath, path.dirname(userDataPath));
    assert.equal(result.availability.globalStorage, true);
  });

  it("accepts a custom-named User-layout directory with a storage anchor", () => {
    const homeDir = createTemporaryDirectory();
    const userDataPath = path.join(homeDir, "fixture-root");
    fs.mkdirSync(path.join(userDataPath, "workspaceStorage"), {
      recursive: true,
    });

    const result = discoverTraeRoot({
      traeRoot: userDataPath,
      platform: "darwin",
      homeDir,
    });

    assert.ok(result);
    assert.equal(result.product, "custom");
    assert.equal(result.userDataPath, userDataPath);
  });

  it("expands a home-relative traeRoot", () => {
    const homeDir = createTemporaryDirectory();
    const userDataPath = path.join(homeDir, "Trae CN", "User");
    fs.mkdirSync(userDataPath, { recursive: true });

    const result = discoverTraeRoot({
      traeRoot: "~/Trae CN",
      platform: "darwin",
      homeDir,
    });

    assert.ok(result);
    assert.equal(result.userDataPath, userDataPath);
  });

  it("does not fall back to defaults when traeRoot is explicit", () => {
    const homeDir = createTemporaryDirectory();
    fs.mkdirSync(
      path.join(
        homeDir,
        "Library",
        "Application Support",
        "Trae CN",
        "User",
        "workspaceStorage",
      ),
      { recursive: true },
    );

    assert.equal(
      discoverTraeRoot({
        traeRoot: path.join(homeDir, "missing"),
        platform: "darwin",
        homeDir,
      }),
      null,
    );
  });

  it("uses win32 path semantics independently of the host platform", () => {
    const userDataPath =
      "C:\\Users\\tester\\AppData\\Roaming\\Trae CN\\User";
    const existingDirectories = new Set([
      userDataPath.toLowerCase(),
      `${userDataPath}\\workspaceStorage`.toLowerCase(),
    ]);

    const result = discoverTraeRoot({
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: {
        APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      },
      isDirectory: (candidatePath) =>
        existingDirectories.has(candidatePath.toLowerCase()),
    });

    assert.ok(result);
    assert.equal(result.product, "trae-cn");
    assert.equal(result.userDataPath, userDataPath);
    assert.equal(
      result.workspaceStoragePath,
      `${userDataPath}\\workspaceStorage`,
    );
  });

  it("returns an empty User directory for diagnostics when no store exists", () => {
    const homeDir = createTemporaryDirectory();
    const userDataPath = path.join(
      homeDir,
      "Library",
      "Application Support",
      "Trae CN",
      "User",
    );
    fs.mkdirSync(userDataPath, { recursive: true });

    const result = discoverTraeRoot({ platform: "darwin", homeDir });

    assert.ok(result);
    assert.equal(result.userDataPath, userDataPath);
    assert.deepStrictEqual(result.availability, {
      globalStorage: false,
      workspaceStorage: false,
      modularData: false,
    });
  });
});

describe("requireTraeRoot", () => {
  it("throws a stable source error when no root is found", () => {
    const homeDir = createTemporaryDirectory();

    assert.throws(
      () => requireTraeRoot({ platform: "darwin", homeDir }),
      (error) => {
        assert.ok(error instanceof Trae2OpenCodeError);
        assert.equal(error.code, "T2O_TRAE_ROOT_NOT_FOUND");
        assert.equal(error.exitCode, 4);
        return true;
      },
    );
  });

  it("rejects unsupported platforms before probing paths", () => {
    assert.throws(
      () =>
        requireTraeRoot({
          traeRoot: "/tmp/trae",
          platform: "linux",
        }),
      (error) => {
        assert.ok(error instanceof Trae2OpenCodeError);
        assert.equal(error.code, "T2O_TRAE_PLATFORM_UNSUPPORTED");
        return true;
      },
    );
  });
});
