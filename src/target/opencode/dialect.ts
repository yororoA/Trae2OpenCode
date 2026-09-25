import type { Diagnostic, MigrationBundle } from "../../ir/types.js";
import type { OpenCodeDialect } from "./contract.js";
import type { OpenCodeMappingOptions, OpenCodeSession } from "./mapping.js";
import { mapOpenCodeSession } from "./mapping.js";
import {
  reconcileOpenCodeTransfer, type OpenCodeReconciliation,
} from "./reconciliation.js";
import { mapOpenCodeV1Session } from "./v1/mapping.js";
import { reconcileOpenCodeV1Session } from "./v1/reconciliation.js";

export interface TargetMappingOptions extends OpenCodeMappingOptions {
  dialect: OpenCodeDialect;
  /** The verified executable version; only the v1 payload persists it. */
  targetVersion: string;
}

export interface TargetMapping {
  transfer: OpenCodeSession;
  diagnostics: Diagnostic[];
}

export function mapTargetSession(
  value: MigrationBundle, sourceSessionId: string, options: TargetMappingOptions,
): TargetMapping {
  return options.dialect === "v1"
    ? mapOpenCodeV1Session(value, sourceSessionId, options)
    : mapOpenCodeSession(value, sourceSessionId, options);
}

export interface TargetReconciliation {
  /** Reconcile a planned payload against its readback using this dialect's contract. */
  reconcile(expected: unknown, actual: unknown): OpenCodeReconciliation;
  /** The manifest snapshot for one payload under this dialect. */
  snapshot(value: unknown): OpenCodeReconciliation["expected"];
  assertTransfer(value: unknown): void;
}

export function targetReconciliation(dialect: OpenCodeDialect): TargetReconciliation {
  const reconcile = dialect === "v1" ? reconcileOpenCodeV1Session : reconcileOpenCodeTransfer;
  return {
    reconcile,
    snapshot: (value) => reconcile(value, value).expected,
    assertTransfer: (value) => { reconcile(value, value); },
  };
}