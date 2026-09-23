import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTraeQueryCache } from "../trae/user-messages.js";

const file = {
  id: "image-a", name: "picture.png", size: 10, type: "image/png",
  kind: "image", resourceUri: "paste-files/picture.png",
};
function parse(files: unknown[]) {
  return parseTraeQueryCache([{ inputText: "", parsedQuery: [], multiMedia: [], files }], "workspace-a", "3.3.104");
}

describe("query cache file fields", () => {
  it("accepts absent upload mode and preserves the official image dimensions", () => {
    const report = parse([{ ...file, imageWidth: 640, imageHeight: 480 }]);
    assert.deepEqual(report.issues, []);
    assert.equal(report.queryCacheEntries[0].files[0].uploadMode, undefined);
    assert.equal(report.queryCacheEntries[0].files[0].width, 640);
    assert.equal(report.queryCacheEntries[0].files[0].height, 480);
  });

  it("retains legacy dimension aliases and rejects invalid present fields", () => {
    assert.equal(parse([{ ...file, width: 2, height: 3, uploadMode: "remote" }]).queryCacheEntries[0].files[0].height, 3);
    for (const invalid of [{ uploadMode: 1 }, { uploadMode: "" }, { imageWidth: 0 }, { imageHeight: "invalid" }]) {
      const report = parse([{ ...file, ...invalid }]);
      assert.equal(report.queryCacheEntries.length, 0);
      assert.equal(report.issues[0].code, "T2O_TRAE_QUERY_CACHE_ENTRY_INVALID");
    }
  });
});
