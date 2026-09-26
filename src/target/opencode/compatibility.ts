import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hashCanonicalJson } from "../../ir/canonical.js";
import type { AssistantEventIR, JsonValue } from "../../ir/types.js";
import { readBundleFile } from "../../migration/bundle-file.js";
import { Trae2OpenCodeError } from "../../shared/errors.js";
import { requireOpenCodeCapabilities, type OpenCodeCompatibilityEvidence } from "./capability-probe.js";
import { extractTransferSchema } from "./contract.js";
import { mapTargetSession, targetReconciliation } from "./dialect.js";
import { withIsolatedOpenCodeServer, type IsolatedOpenCodeServer } from "./isolated-server.js";
import { MAX_CONTINUATION_CONTEXT_BYTES } from "./mapping.js";
import { createNativeOpenCodeAdapter } from "./native-adapter.js";
import { extractV1SessionSchema, V1_OPENAPI_ROUTE } from "./v1/contract.js";

async function requireFailure(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Trae2OpenCodeError && error.code === code) return;
    throw error;
  }
  throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
}

/** No transcript, credentials, target URL or user environment enters this disposable run. */
export async function verifyIsolatedCompatibility(
  binary: string, evidence: OpenCodeCompatibilityEvidence,
): Promise<void> {
  await withIsolatedOpenCodeServer({ binary }, async (server) => {
    await exerciseOpenCodeRoundtrip(server, evidence);
  });
}

/** Only call with a disposable server: the public verifier and migration canary share this run. */
export async function exerciseOpenCodeRoundtrip(
  server: IsolatedOpenCodeServer, expectedEvidence?: OpenCodeCompatibilityEvidence,
) {
  let evidence = expectedEvidence ? structuredClone(expectedEvidence) : undefined;
  // This private transport pins protocol evidence while exercising the production
  // adapter. It must never escape this run or recursively start another canary.
  const transport = {
    ...server.transport,
    async verifyCompatibility(observed: OpenCodeCompatibilityEvidence) {
      evidence ??= structuredClone(observed);
      if (hashCanonicalJson(observed as unknown as JsonValue) !==
        hashCanonicalJson(evidence as unknown as JsonValue)) {
        throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
      }
    },
  };
  const capabilities = await requireOpenCodeCapabilities(transport);
  await transport.verifyCompatibility({
    dialect: capabilities.dialect, binaryVersion: capabilities.binaryVersion!,
    serverVersion: capabilities.serverVersion!, schemaHash: capabilities.schemaHash!,
  });
  const api = await transport.request(capabilities.dialect === "v1" ? V1_OPENAPI_ROUTE : "/openapi.json");
  if (api.status !== 200) throw new Trae2OpenCodeError("T2O_OPENCODE_CAPABILITY_UNAVAILABLE");
  const schema = capabilities.dialect === "v1"
    ? extractV1SessionSchema(api.body) : extractTransferSchema(api.body);
  if (hashCanonicalJson(schema as JsonValue) !== capabilities.schemaHash) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_SCHEMA_UNSUPPORTED");
  }
  const adapter = createNativeOpenCodeAdapter({
    serverUrl: server.serverUrl, transport, temporaryRoot: server.directory,
  });
  const bundle = await readBundleFile(fileURLToPath(new URL(
    "../../../fixtures/ir/v1/valid-trae-assembled.json", import.meta.url,
  )));
  const fixtureSha256 = hashCanonicalJson(bundle as unknown as JsonValue);
  // This is the shipped synthetic fixture, never a user transcript.
  const childSource = JSON.parse(
    JSON.stringify(bundle.sessions[0]).replaceAll("session-synthetic", "session-synthetic-child"),
  ) as typeof bundle.sessions[number];
  childSource.parentSourceId = "session-synthetic";
  bundle.sessions.push(childSource);
  const nonce = randomUUID().replaceAll("-", "");
  const reconciliation = targetReconciliation(capabilities.dialect);
  const map = (suffix: string, parentId?: string) => mapTargetSession(
    bundle, parentId ? "session-synthetic-child" : "session-synthetic", {
      dialect: capabilities.dialect, targetVersion: capabilities.binaryVersion!,
      sessionId: `ses_compat_${nonce}_${suffix}`, parentId, directory: server.directory,
      messageIds: new Map([
        ["user-synthetic", `msg_compat_${nonce}_${suffix}_0001`],
        ["assistant-synthetic", `msg_compat_${nonce}_${suffix}_0002`],
      ]),
    },
  ).transfer;
  const check = (expected: unknown, actual: unknown) => {
    if (reconciliation.reconcile(expected, actual).status !== "verified") {
      throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
    }
  };
  const parent = map("parent");
  const parentId = String(parent.info.id);
  if (await adapter.readSession(parentId) !== null) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
  }
  const imported = await adapter.importSession(parent);
  check(parent, imported);
  check(parent, await adapter.exportSession(parentId));
  check(parent, await adapter.readSession(parentId));
  await requireFailure(() => adapter.importSession(parent), "T2O_OPENCODE_SESSION_CONFLICT");
  check(parent, await adapter.readSession(parentId));

  const child = map("child", parentId);
  const childId = String(child.info.id);
  const importedChild = await adapter.importSession(child);
  check(child, importedChild);
  const children = await adapter.listChildren(parentId);
  if (children.length !== 1 || children[0] !== childId) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
  }
  const parentHash = hashCanonicalJson(imported as unknown as JsonValue);
  await requireFailure(() => adapter.deleteSession(parentId, parentHash, true),
    "T2O_MIGRATION_CHILDREN_PROTECTED");
  await requireFailure(() => adapter.deleteSession(childId, hashCanonicalJson("wrong"), true),
    "T2O_MIGRATION_TARGET_CHANGED");
  await adapter.deleteSession(childId, hashCanonicalJson(importedChild as unknown as JsonValue), true);
  await adapter.deleteSession(parentId, parentHash, true);
  if (await adapter.readSession(childId) !== null || await adapter.readSession(parentId) !== null) {
    throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
  }

  if (capabilities.dialect === "v2") {
    const assistant = bundle.sessions[0].events.find(
      (event): event is AssistantEventIR => event.type === "assistant",
    );
    const text = assistant?.content.find((part) => part.type === "text");
    if (text?.type !== "text") throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
    text.text = "x".repeat(MAX_CONTINUATION_CONTEXT_BYTES + 1);
    const compacted = map("compaction");
    const actual = await adapter.importSession(compacted);
    check(compacted, actual);
    // Large v2 history uses HTTP readback in production; CLI export was exercised above.
    check(compacted, await adapter.readSession(String(compacted.info.id)));
    await adapter.deleteSession(String(compacted.info.id), hashCanonicalJson(actual as unknown as JsonValue), true);
  }
  const finalCapabilities = await requireOpenCodeCapabilities(transport);
  await transport.verifyCompatibility({
    dialect: finalCapabilities.dialect, binaryVersion: finalCapabilities.binaryVersion!,
    serverVersion: finalCapabilities.serverVersion!, schemaHash: finalCapabilities.schemaHash!,
  });
  return {
    schema,
    report: {
      reportVersion: 2,
      targetVersion: capabilities.binaryVersion!,
      serverVersion: capabilities.serverVersion!,
      dialect: capabilities.dialect,
      compatibility: capabilities.compatibility,
      checkedAt: new Date().toISOString(),
      status: "verified",
      source: "synthetic-fixture-only",
      fixtureSha256,
      schemaSha256: capabilities.schemaHash!,
      isolation: { privateServer: true, separateDatabase: true, separateHomeAndXdgDirectories: true },
      checks: {
        nativeImportExport: true,
        adapterReadback: true,
        duplicateImportRejected: true,
        duplicateTranscriptUnchanged: true,
        parentChildRoundtrip: true,
        parentDeletionProtected: true,
        changedHashDeletionProtected: true,
        deletionReadback: true,
        ...(capabilities.dialect === "v2" ? { hiddenCompactionReadback: true } : {}),
      },
      limitations: [
        "Synthetic mapped sessions only; does not certify TRAE recovery or arbitrary native inputs.",
        "Readback uses CLI export in v1 and HTTP export in v2; basic v2 CLI export is also checked.",
        "Historical M0 unfinished-assistant loss experiments are not rerun by this verifier.",
      ],
    },
  };
}

async function resolveProbeBinary(binary: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const candidates = /[/\\]/.test(binary) ? [path.resolve(cwd, binary)]
    : (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)
      .map((directory) => path.resolve(cwd, directory, binary));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate);
    } catch { /* Continue through PATH without logging private paths. */ }
  }
  throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
}

/** Cache only within one transport, and invalidate when the executable or contract changes. */
export function createCompatibilityVerifier(options: {
  binary: string; env: NodeJS.ProcessEnv; cwd: string;
}) {
  let cached: { key: string; result: Promise<void> } | undefined;
  return async (evidence: OpenCodeCompatibilityEvidence): Promise<void> => {
    try {
      const binary = await resolveProbeBinary(options.binary, options.env, options.cwd);
      const signature = async () => {
        const stat = await fs.stat(binary);
        return JSON.stringify([binary, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, evidence]);
      };
      const key = await signature();
      if (cached?.key !== key) cached = { key, result: verifyIsolatedCompatibility(binary, evidence) };
      await cached.result;
      if (await signature() !== key) throw new Error("Executable changed during verification");
    } catch {
      cached = undefined;
      // Canary exceptions may contain synthetic data or paths; expose only the stable code.
      throw new Trae2OpenCodeError("T2O_OPENCODE_COMPATIBILITY_UNVERIFIED");
    }
  };
}
