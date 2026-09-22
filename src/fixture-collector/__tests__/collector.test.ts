/** Fixture 采集器单元测试 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { analyzeJsonStructure, hashFileSha256 } from "../snapshot";
import { discoverTraeRoots } from "../discovery";

describe("analyzeJsonStructure", () => {
  it("提取顶层 key", () => {
    const obj = { a: 1, b: "hello", c: { d: 2 } };
    const result = analyzeJsonStructure(obj);
    assert.deepStrictEqual(result.keys, ["a", "b", "c"]);
  });

  it("检测嵌套 key", () => {
    const obj = { config: { host: "localhost", port: 8080 } };
    const result = analyzeJsonStructure(obj);
    assert.ok(result.nestedKeys["$"]?.includes("config"));
    assert.ok(result.nestedKeys["$.config"]?.includes("host"));
    assert.ok(result.nestedKeys["$.config"]?.includes("port"));
  });

  it("采样数组元素", () => {
    const obj = { items: [{ id: 1, name: "a" }, { id: 2, name: "b" }] };
    const result = analyzeJsonStructure(obj);
    assert.deepStrictEqual(result.arrayItemSampleKeys, ["id", "name"]);
  });

  it("空对象返回空 keys", () => {
    const result = analyzeJsonStructure({});
    assert.deepStrictEqual(result.keys, []);
    assert.strictEqual(result.maxDepth, 0);
  });

  it("最大深度限制", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: 1 } } } } } } } } } } };
    const result = analyzeJsonStructure(deep);
    assert.ok(result.maxDepth <= 10);
  });
});

describe("hashFileSha256", () => {
  it("生成稳定 hash", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t2o-test-"));
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "hello world");
    const hash = hashFileSha256(filePath);
    assert.strictEqual(typeof hash, "string");
    assert.strictEqual(hash.length, 64);
    // 相同内容应产生相同 hash
    assert.strictEqual(hash, hashFileSha256(filePath));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("discoverTraeRoots", () => {
  it("不存在时返回 null", () => {
    const result = discoverTraeRoots("/nonexistent/path/to/trae");
    assert.strictEqual(result, null);
  });
});