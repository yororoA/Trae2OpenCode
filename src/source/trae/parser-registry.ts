import { parseTraeRuntimeAssistantMessages, scanTraeLongTextResources } from "./assistant-messages.js";
import {
  resolveTraeParserProfile,
  type TraeProfileSelection,
} from "./profile-definitions.js";
import { parseTraeReasoningPlan } from "./reasoning-plan.js";
import { scanTraeResources } from "./resources.js";
import { parseTraeRuntimeSessionMetadata, readTraeSessionMetadata } from "./session-metadata.js";
import { parseTraeToolCalls } from "./tool-calls.js";
import { parseTraeQueryCache, parseTraeRuntimeUserMessages } from "./user-messages.js";

/** Resolve once, bind the verified version, and expose only that source's parsers.
 * Registration describes parsing capability; it never asserts runtime availability.
 */
export function createTraeParser(selection: TraeProfileSelection) {
  const profile = resolveTraeParserProfile(selection);
  const productVersion = profile.productVersion;
  if (profile.sourceKind === "runtime") {
    return Object.freeze({
      kind: "runtime" as const,
      profile,
      parseSessionMetadata: (value: unknown) => parseTraeRuntimeSessionMetadata(value, productVersion),
      parseUserMessages: (value: unknown) => parseTraeRuntimeUserMessages(value, productVersion),
      parseAssistantMessages: (value: unknown) => parseTraeRuntimeAssistantMessages(value, productVersion),
      parseReasoningPlan: (
        value: unknown,
        messageType: "general" | "task",
        mappedTextLocators: readonly string[] = [],
      ) => parseTraeReasoningPlan(value, messageType, productVersion, mappedTextLocators),
      parseToolCalls: (value: unknown, messageType: "general" | "task") =>
        parseTraeToolCalls(value, messageType, productVersion),
    });
  }
  return Object.freeze({
    kind: "workspace" as const,
    profile,
    readSessionMetadata: (options: Omit<Parameters<typeof readTraeSessionMetadata>[0], "productVersion" | "runtimeMetadataProvider">) =>
      readTraeSessionMetadata({ root: options.root, temporaryRoot: options.temporaryRoot, productVersion }),
    parseQueryCache: (value: unknown, workspaceStorageId: string) =>
      parseTraeQueryCache(value, workspaceStorageId, productVersion),
    scanLongText: (
      root: Parameters<typeof scanTraeLongTextResources>[0],
      queryCacheEntries: Parameters<typeof scanTraeLongTextResources>[2] = [],
      references: Parameters<typeof scanTraeLongTextResources>[3] = [],
    ) => scanTraeLongTextResources(root, productVersion, queryCacheEntries, references),
    scanResources: (
      root: Parameters<typeof scanTraeResources>[0],
      queryCacheEntries: Parameters<typeof scanTraeResources>[2] = [],
      references: Parameters<typeof scanTraeResources>[3] = [],
    ) => scanTraeResources(root, productVersion, queryCacheEntries, references),
  });
}

export type TraeParser = ReturnType<typeof createTraeParser>;
