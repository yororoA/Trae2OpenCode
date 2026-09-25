import assert from "node:assert/strict";
import { constants as bufferConstants } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { JsonValue } from "../../ir/types.js";
import {
  createStreamingJsonParser,
  jsonByteLength,
  jsonChunks,
  JsonSizeLimitError,
  writeJson,
} from "../json-stream.js";
import {
  GIBIBYTE,
  LARGE_TRANSFER_TIMEOUT_MS,
  MAX_BUNDLE_BYTES,
  MAX_OPENCODE_TRANSFER_BYTES,
  MAX_RUNTIME_TOTAL_BYTES,
  MAX_TRAE_CDP_MESSAGE_BYTES,
  MEBIBYTE,
} from "../limits.js";

describe("streaming JSON", () => {
  it("parses UTF-8 values split at arbitrary byte boundaries", () => {
    const expected = { text: "中文", nested: [true, null, 12.5] };
    const parser = createStreamingJsonParser();
    const input = Buffer.from(JSON.stringify(expected));
    for (const byte of input) parser.write(Uint8Array.of(byte));
    assert.deepEqual(parser.end(), expected);
  });

  it("matches canonical JSON formatting without constructing a sorted clone", () => {
    const value = { z: [3, { b: 2, a: 1 }], a: "text" } as JsonValue;
    const actual = [...jsonChunks(value, {
      pretty: true,
      sortKeys: true,
      trailingNewline: true,
    })].join("");
    assert.equal(actual, '{\n  "a": "text",\n  "z": [\n    3,\n    {\n      "a": 1,\n      "b": 2\n    }\n  ]\n}\n');
  });

  it("streams escaping without splitting a surrogate pair", () => {
    const text = `${"x".repeat(64 * 1024 - 1)}😀\\"\\n`;
    const value = { text } as JsonValue;
    assert.equal([...jsonChunks(value)].join(""), JSON.stringify(value));
    const runtimeValue = { omitted: undefined, array: [undefined, "kept"] };
    assert.equal(
      [...jsonChunks(runtimeValue as unknown as JsonValue)].join(""),
      JSON.stringify(runtimeValue),
    );
  });

  it("measures and writes incrementally while stopping at a byte limit", async () => {
    const value = { text: "中文", items: [1, 2, 3] } as JsonValue;
    const serialized = JSON.stringify(value);
    assert.equal(jsonByteLength(value), Buffer.byteLength(serialized));
    assert.throws(
      () => jsonByteLength(value, {}, Buffer.byteLength(serialized) - 1),
      JsonSizeLimitError,
    );

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2o-json-stream-"));
    try {
      const filename = path.join(root, "value.json");
      const file = await fs.open(filename, "wx", 0o600);
      try {
        await writeJson(file, value);
      } finally {
        await file.close();
      }
      assert.equal(await fs.readFile(filename, "utf8"), serialized);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the total bundle at 1 GiB and one transfer below V8's string ceiling", () => {
    assert.equal(MAX_BUNDLE_BYTES, GIBIBYTE);
    assert.equal(MAX_RUNTIME_TOTAL_BYTES, GIBIBYTE);
    assert.equal(MAX_OPENCODE_TRANSFER_BYTES, 384 * MEBIBYTE);
    assert.equal(MAX_TRAE_CDP_MESSAGE_BYTES, 385 * MEBIBYTE);
    assert.equal(LARGE_TRANSFER_TIMEOUT_MS, 120_000);
    assert.ok(MAX_OPENCODE_TRANSFER_BYTES < bufferConstants.MAX_STRING_LENGTH);
  });
});
