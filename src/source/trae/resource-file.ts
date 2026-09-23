import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ResourceFileMetadata {
  sha256: string;
  sizeBytes: number;
  mimeType: string;
}

/** Every component below the trusted storage root must be a real directory/file. */
export function assertResourcePath(storageRoot: string, filePath: string): void {
  const relative = path.relative(path.resolve(storageRoot), path.resolve(filePath));
  const isOutside =
    relative === "" || relative === ".." ||
    relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (isOutside) throw new Error("Invalid resource boundary.");
  const parts = relative.split(path.sep);
  let current = storageRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    const isParent = index < parts.length - 1;
    if (stat.isSymbolicLink() || (isParent && !stat.isDirectory())) {
      throw new Error("Invalid resource component.");
    }
  }
  const resolvedRelative = path.relative(fs.realpathSync(storageRoot), fs.realpathSync(filePath));
  const escapesResolvedRoot =
    resolvedRelative === ".." ||
    resolvedRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(resolvedRelative);
  if (escapesResolvedRoot) throw new Error("Invalid resolved resource boundary.");
}

function detectMime(prefix: Buffer, validUtf8: boolean): string {
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(prefix.toString("ascii", 0, 6))) return "image/gif";
  const isWebp = prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WEBP";
  if (isWebp) return "image/webp";
  if (prefix.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  return validUtf8 ? "text/plain" : "application/octet-stream";
}

/** Hash in bounded chunks, reject special files, and detect mutation while reading. */
export function inspectResourceFile(
  storageRoot: string,
  filePath: string,
  requireUtf8 = false,
): ResourceFileMetadata {
  assertResourcePath(storageRoot, filePath);
  const before = fs.lstatSync(filePath);
  if (!before.isFile()) throw new Error("Resource is not a regular file.");
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    const sameFile = opened.isFile() && before.dev === opened.dev && before.ino === opened.ino;
    if (!sameFile) throw new Error("Resource changed before reading.");
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let prefix = Buffer.alloc(0);
    let sizeBytes = 0;
    let validUtf8 = true;
    for (;;) {
      const size = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (size === 0) break;
      const bytes = chunk.subarray(0, size);
      if (sizeBytes === 0) prefix = Buffer.from(bytes.subarray(0, 512));
      hash.update(bytes);
      sizeBytes += size;
      if (validUtf8) {
        try {
          decoder.decode(bytes, { stream: true });
          // NUL-containing data must not be classified as plain text.
          if (!requireUtf8 && bytes.includes(0)) validUtf8 = false;
        } catch {
          validUtf8 = false;
        }
      }
    }
    if (validUtf8) {
      try { decoder.decode(); } catch { validUtf8 = false; }
    }
    const after = fs.fstatSync(descriptor);
    const unchanged =
      opened.size === sizeBytes && after.size === sizeBytes &&
      opened.mtimeMs === after.mtimeMs && opened.ctimeMs === after.ctimeMs;
    if (!unchanged || (requireUtf8 && !validUtf8)) throw new Error("Resource is invalid or changed.");
    assertResourcePath(storageRoot, filePath);
    const current = fs.lstatSync(filePath);
    if (current.dev !== after.dev || current.ino !== after.ino) throw new Error("Resource was replaced.");
    return {
      sha256: `sha256:${hash.digest("hex")}`,
      sizeBytes,
      mimeType: requireUtf8 ? "text/plain" : detectMime(prefix, validUtf8),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}
