import type { FileHandle } from "node:fs/promises";
import { JSONParser } from "@streamparser/json";
import type { JsonValue } from "../ir/types.js";

const BUFFER_CHARACTERS = 64 * 1024;

export class JsonSizeLimitError extends Error {}

export interface JsonSerializationOptions {
  pretty?: boolean;
  sortKeys?: boolean;
  trailingNewline?: boolean;
}

function isJsonStringifyOmitted(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function* serializeJsonString(value: string): Generator<string> {
  yield '"';
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + BUFFER_CHARACTERS, value.length);
    const splitsSurrogatePair = end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff;
    if (splitsSurrogatePair) end++;
    const serialized = JSON.stringify(value.slice(start, end));
    yield serialized.slice(1, -1);
    start = end;
  }
  yield '"';
}

function* serializeJsonValue(
  value: JsonValue,
  options: JsonSerializationOptions,
  depth: number,
): Generator<string> {
  const pretty = options.pretty === true;
  const newline = pretty ? "\n" : "";
  const indent = (level: number) => pretty ? "  ".repeat(level) : "";
  const separator = pretty ? ": " : ":";
  if (Array.isArray(value)) {
    yield "[";
    if (value.length > 0) {
      yield newline;
      for (let index = 0; index < value.length; index++) {
        yield indent(depth + 1);
        const item = value[index] as JsonValue | undefined;
        if (isJsonStringifyOmitted(item)) yield "null";
        else yield* serializeJsonValue(item!, options, depth + 1);
        yield index + 1 === value.length ? newline : `,${newline}`;
      }
      yield indent(depth);
    }
    yield "]";
    return;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => !isJsonStringifyOmitted(value[key]));
    if (options.sortKeys) keys.sort((left, right) => left.localeCompare(right));
    yield "{";
    if (keys.length > 0) {
      yield newline;
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        yield indent(depth + 1);
        yield* serializeJsonString(key);
        yield separator;
        yield* serializeJsonValue(value[key], options, depth + 1);
        yield index + 1 === keys.length ? newline : `,${newline}`;
      }
      yield indent(depth);
    }
    yield "}";
    return;
  }
  if (typeof value === "string") {
    yield* serializeJsonString(value);
    return;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Value is not JSON serializable");
  yield serialized;
}

/** Produces bounded chunks without constructing one document-sized string. */
export function* jsonChunks(
  value: JsonValue,
  options: JsonSerializationOptions = {},
): Generator<string> {
  let buffered: string[] = [];
  let characters = 0;
  for (const chunk of serializeJsonValue(value, options, 0)) {
    if (characters > 0 && characters + chunk.length > BUFFER_CHARACTERS) {
      yield buffered.join("");
      buffered = [];
      characters = 0;
    }
    if (chunk.length >= BUFFER_CHARACTERS) {
      if (characters > 0) yield buffered.join("");
      yield chunk;
      buffered = [];
      characters = 0;
      continue;
    }
    buffered.push(chunk);
    characters += chunk.length;
  }
  if (options.trailingNewline) buffered.push("\n");
  if (buffered.length > 0) yield buffered.join("");
}

export function jsonByteLength(
  value: JsonValue,
  options: JsonSerializationOptions = {},
  maxBytes = Number.MAX_SAFE_INTEGER,
): number {
  let bytes = 0;
  for (const chunk of jsonChunks(value, options)) {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > maxBytes) throw new JsonSizeLimitError();
  }
  return bytes;
}

export async function writeJson(
  file: FileHandle,
  value: JsonValue,
  options: JsonSerializationOptions = {},
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<number> {
  let bytes = 0;
  for (const chunk of jsonChunks(value, options)) {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > maxBytes) throw new JsonSizeLimitError();
    await file.writeFile(chunk);
  }
  return bytes;
}

/** Builds one JSON value while accepting arbitrarily split UTF-8 input chunks. */
export function createStreamingJsonParser() {
  const parser = new JSONParser({
    paths: ["$"],
    stringBufferSize: BUFFER_CHARACTERS,
    numberBufferSize: 64,
  });
  let complete = false;
  let value: unknown;
  parser.onValue = (parsed) => {
    if (complete) throw new SyntaxError("Multiple JSON values");
    complete = true;
    value = parsed.value;
  };
  return {
    write(chunk: Uint8Array): void {
      parser.write(chunk);
    },
    end(): unknown {
      if (!parser.isEnded) parser.end();
      if (!complete) throw new SyntaxError("Missing JSON value");
      return value;
    },
  };
}
