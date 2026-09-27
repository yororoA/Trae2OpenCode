import { hashCanonicalJson } from "../../ir/canonical.js";
import type { JsonValue } from "../../ir/types.js";

export type SchemaCompatibility = "exact" | "compatible" | "incompatible";

export interface SchemaCompatibilityAnalysis {
  status: SchemaCompatibility;
  baselineHash: string;
  actualHash: string;
  changeCount: number;
  /** Schema locations only; values from the target document are never included. */
  changes: string[];
}

interface Comparison {
  compatible: boolean;
  changeCount: number;
  changes: string[];
}

interface Budget {
  nodes: number;
}

const MAX_SCHEMA_NODES = 100_000;
const MAX_SCHEMA_DEPTH = 256;
const MAX_REPORTED_CHANGES = 100;
const ANNOTATION_KEYS = new Set(["title", "description", "default", "examples", "deprecated"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(left: unknown, right: unknown): boolean {
  return hashCanonicalJson(left as JsonValue) === hashCanonicalJson(right as JsonValue);
}

function result(compatible = true): Comparison {
  return { compatible, changeCount: 0, changes: [] };
}

function record(change: Comparison, path: string): void {
  change.changeCount++;
  if (change.changes.length < MAX_REPORTED_CHANGES) change.changes.push(path);
}

function merge(target: Comparison, source: Comparison): void {
  target.compatible &&= source.compatible;
  target.changeCount += source.changeCount;
  for (const path of source.changes) {
    if (target.changes.length >= MAX_REPORTED_CHANGES) break;
    target.changes.push(path);
  }
}

function fail(path: string): Comparison {
  const comparison = result(false);
  record(comparison, path);
  return comparison;
}

function primitiveSet(value: unknown): Map<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = new Map<string, unknown>();
  for (const item of value) {
    if (item !== null && typeof item === "object") return undefined;
    items.set(JSON.stringify(item), item);
  }
  return items;
}

function compareSet(
  baseline: unknown, actual: unknown, path: string, allowActualAdditions: boolean,
): Comparison {
  const left = primitiveSet(baseline);
  const right = primitiveSet(actual);
  if (!left || !right) return fail(path);
  for (const key of left.keys()) {
    if (!right.has(key)) return fail(path);
  }
  if (!allowActualAdditions && left.size !== right.size) return fail(path);
  const comparison = result();
  if (!same(baseline, actual)) record(comparison, path);
  return comparison;
}

function compareAlternatives(
  baseline: unknown, actual: unknown, path: string, allowActualAdditions: boolean,
  allowBranchChanges: boolean, budget: Budget, depth: number,
): Comparison {
  if (!Array.isArray(baseline) || !Array.isArray(actual) ||
      actual.length < baseline.length || (!allowActualAdditions && actual.length !== baseline.length) ||
      baseline.length > 256 || actual.length > 256) {
    return fail(path);
  }
  const matrix = baseline.map((expected, expectedIndex) =>
    actual.map((observed) => allowBranchChanges
      ? compareNode(expected, observed, `${path}[${expectedIndex}]`, budget, depth + 1)
      : (same(expected, observed) ? result() : fail(`${path}[${expectedIndex}]`))));
  const matchedExpectedByActual = new Array<number>(actual.length).fill(-1);
  const assign = (expectedIndex: number, visited: boolean[]): boolean => {
    for (let actualIndex = 0; actualIndex < actual.length; actualIndex++) {
      if (visited[actualIndex] || !matrix[expectedIndex]![actualIndex]!.compatible) continue;
      visited[actualIndex] = true;
      const previous = matchedExpectedByActual[actualIndex]!;
      if (previous === -1 || assign(previous, visited)) {
        matchedExpectedByActual[actualIndex] = expectedIndex;
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < baseline.length; index++) {
    if (!assign(index, new Array<boolean>(actual.length).fill(false))) return fail(path);
  }
  const comparison = result();
  for (let actualIndex = 0; actualIndex < actual.length; actualIndex++) {
    const expectedIndex = matchedExpectedByActual[actualIndex]!;
    if (expectedIndex === -1) {
      record(comparison, `${path}[]`);
      continue;
    }
    merge(comparison, matrix[expectedIndex]![actualIndex]!);
  }
  if (!same(baseline, actual) && comparison.changeCount === 0) record(comparison, path);
  return comparison;
}

function compareProperties(
  baseline: unknown, actual: unknown, path: string,
  baselineParent: Record<string, unknown>, actualParent: Record<string, unknown>,
  budget: Budget, depth: number,
): Comparison {
  if (!isRecord(baseline) || !isRecord(actual)) return fail(path);
  const comparison = result();
  for (const [key, expected] of Object.entries(baseline)) {
    if (!Object.hasOwn(actual, key)) return fail(`${path}.${key}`);
    merge(comparison, compareNode(expected, actual[key], `${path}.${key}`, budget, depth + 1));
    if (!comparison.compatible) return comparison;
  }
  const actualRequired = new Set(Array.isArray(actualParent.required) ? actualParent.required : []);
  for (const key of Object.keys(actual)) {
    if (Object.hasOwn(baseline, key)) continue;
    // A new declared property only broadens a closed object when it remains optional.
    if (baselineParent.additionalProperties !== false || actualParent.additionalProperties !== false ||
        actualRequired.has(key)) {
      return fail(`${path}.${key}`);
    }
    record(comparison, `${path}.${key}`);
  }
  return comparison;
}

function compareSchemaMap(
  baseline: unknown, actual: unknown, path: string, budget: Budget, depth: number,
): Comparison {
  if (!isRecord(baseline) || !isRecord(actual)) return fail(path);
  const comparison = result();
  for (const [key, expected] of Object.entries(baseline)) {
    if (!Object.hasOwn(actual, key)) return fail(`${path}.${key}`);
    merge(comparison, compareNode(expected, actual[key], `${path}.${key}`, budget, depth + 1));
    if (!comparison.compatible) return comparison;
  }
  for (const key of Object.keys(actual)) {
    if (!Object.hasOwn(baseline, key)) record(comparison, `${path}.${key}`);
  }
  return comparison;
}

function compareObject(
  baseline: Record<string, unknown>, actual: Record<string, unknown>,
  path: string, budget: Budget, depth: number,
): Comparison {
  const comparison = result();
  const keys = new Set([...Object.keys(baseline), ...Object.keys(actual)]);
  for (const key of keys) {
    const location = `${path}.${key}`;
    const hasBaseline = Object.hasOwn(baseline, key);
    const hasActual = Object.hasOwn(actual, key);
    if (ANNOTATION_KEYS.has(key)) {
      if (!hasBaseline || !hasActual || !same(baseline[key], actual[key])) record(comparison, location);
      continue;
    }
    if (!hasBaseline || !hasActual) return fail(location);
    let nested: Comparison;
    if (key === "properties") {
      nested = compareProperties(baseline[key], actual[key], location, baseline, actual, budget, depth);
    } else if (key === "schemas" && path.endsWith(".components")) {
      nested = compareSchemaMap(baseline[key], actual[key], location, budget, depth);
    } else if (key === "required" || key === "type") {
      nested = Array.isArray(baseline[key]) || Array.isArray(actual[key])
        ? compareSet(baseline[key], actual[key], location, false)
        : compareNode(baseline[key], actual[key], location, budget, depth + 1);
    } else if (key === "enum") {
      nested = compareSet(baseline[key], actual[key], location, true);
    } else if (key === "anyOf") {
      nested = compareAlternatives(baseline[key], actual[key], location, true, true, budget, depth);
    } else if (key === "oneOf" || key === "allOf") {
      nested = compareAlternatives(baseline[key], actual[key], location, false, false, budget, depth);
    } else {
      nested = compareNode(baseline[key], actual[key], location, budget, depth + 1);
    }
    merge(comparison, nested);
    if (!comparison.compatible) return comparison;
  }
  return comparison;
}

function compareNode(
  baseline: unknown, actual: unknown, path: string, budget: Budget, depth: number,
): Comparison {
  if (++budget.nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) return fail(path);
  if (same(baseline, actual)) return result();
  if (isRecord(baseline) && isRecord(actual)) {
    return compareObject(baseline, actual, path, budget, depth);
  }
  if (Array.isArray(baseline) && Array.isArray(actual) && baseline.length === actual.length) {
    const comparison = result();
    for (let index = 0; index < baseline.length; index++) {
      merge(comparison, compareNode(baseline[index], actual[index], `${path}[${index}]`, budget, depth + 1));
      if (!comparison.compatible) return comparison;
    }
    return comparison;
  }
  return fail(path);
}

/**
 * Determines whether the target schema is a safe candidate for the existing adapter.
 * "compatible" is never write authorization: it must still pass an isolated round trip.
 */
export function analyzeSchemaCompatibility(
  baseline: JsonValue, actual: JsonValue,
): SchemaCompatibilityAnalysis {
  const baselineHash = hashCanonicalJson(baseline);
  const actualHash = hashCanonicalJson(actual);
  if (baselineHash === actualHash) {
    return { status: "exact", baselineHash, actualHash, changeCount: 0, changes: [] };
  }
  const comparison = compareNode(baseline, actual, "$", { nodes: 0 }, 0);
  return {
    status: comparison.compatible ? "compatible" : "incompatible",
    baselineHash,
    actualHash,
    changeCount: comparison.changeCount,
    changes: comparison.changes,
  };
}
