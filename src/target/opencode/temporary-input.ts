import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { Trae2OpenCodeError } from "../../shared/errors.js";

/**
 * A private single-use input file for a native import. The operation's own failure is
 * reported ahead of any cleanup failure so the caller never loses the real cause.
 */
export async function withTemporaryInput<T>(
  root: string,
  content: string | ((file: FileHandle) => Promise<void>),
  operation: (filename: string) => Promise<T>,
): Promise<T> {
  let directory: string | undefined;
  let result: T | undefined;
  let failure: Trae2OpenCodeError | undefined;
  try {
    await fs.mkdir(root, { recursive: true });
    directory = await fs.mkdtemp(path.join(root, "t2o-import-"));
    await fs.chmod(directory, 0o700);
    const filename = path.join(directory, "session.json");
    const file = await fs.open(filename, "wx", 0o600);
    try {
      if (typeof content === "string") await file.writeFile(content);
      else await content(file);
    } finally {
      await file.close();
    }
    result = await operation(filename);
  } catch (error) {
    failure = error instanceof Trae2OpenCodeError
      ? error : new Trae2OpenCodeError("T2O_OPENCODE_IMPORT_FAILED");
  }
  if (directory !== undefined) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch {
      throw new Trae2OpenCodeError("T2O_OPENCODE_TEMP_CLEANUP_FAILED", { cause: failure });
    }
  }
  if (failure) throw failure;
  return result as T;
}
