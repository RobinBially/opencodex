/**
 * The saved-config half of the OpenCode Go DeepSeek reclassification.
 *
 * `enrichProviderFromRegistry` is fill-only and asymmetric: `noVisionModels` is filled
 * all-or-nothing and `modelInputModalities` is filled per-key BENEATH the saved value. A config
 * saved while the registry called `deepseek-v4.1-flash` text-only therefore keeps BOTH halves of
 * that claim forever, and images are stripped for a route that reads them (probed 2026-09-19).
 * Correcting the registry alone fixes new installs only.
 */
import { describe, expect, test } from "bun:test";
import {
  projectStaleVisionClassifications,
  STALE_VISION_CLASSIFICATIONS,
} from "../../src/providers/stale-vision-classification-migration";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import type { OcxConfig } from "../../src/types";

const MODEL = "deepseek-v4.1-flash";
const SIBLING = "deepseek-v4-flash";

/** A config saved while the stale seed was current. */
function staleConfig(
  modalities: Record<string, string[]> = { [MODEL]: ["text"], [SIBLING]: ["text"] },
  noVisionModels: string[] = [MODEL, SIBLING],
  adapter = "openai-chat",
): OcxConfig {
  return {
    providers: {
      "opencode-go": { adapter, baseUrl: "https://opencode.ai/zen/go/v1", modelInputModalities: { ...modalities }, noVisionModels: [...noVisionModels] },
    },
  } as unknown as OcxConfig;
}

describe("stale vision classification migration", () => {
  test("repairs both halves of the stale claim", () => {
    // Modalities alone would not be enough: the sidecar predicate checks noVisionModels FIRST and
    // short-circuits, so a row left in that list stays text-only however it is declared.
    const config = staleConfig();
    const projection = projectStaleVisionClassifications(config);
    expect(projection.changed).toBe(true);
    expect(projection.config.providers!["opencode-go"]!.modelInputModalities![MODEL]).toEqual(["text", "image"]);
    expect(projection.config.providers!["opencode-go"]!.noVisionModels).not.toContain(MODEL);
    expect(projection.warnings.join(" ")).toContain(MODEL);
  });

  test("leaves the sibling route classified text-only", () => {
    // deepseek-v4-flash still answers HTTP 400 "Model only supports text input" on this gateway.
    // A migration that widened the whole list would strip a real protection.
    const projection = projectStaleVisionClassifications(staleConfig());
    expect(projection.config.providers!["opencode-go"]!.modelInputModalities![SIBLING]).toEqual(["text"]);
    expect(projection.config.providers!["opencode-go"]!.noVisionModels).toContain(SIBLING);
  });

  test("leaves a modality value the operator chose alone", () => {
    // The guard is an exact match on the stale declaration. Anything else is a deliberate
    // override and outranks this migration.
    const projection = projectStaleVisionClassifications(
      staleConfig({ [MODEL]: ["text", "audio"], [SIBLING]: ["text"] }),
    );
    expect(projection.changed).toBe(false);
    expect(projection.config.providers!["opencode-go"]!.modelInputModalities![MODEL]).toEqual(["text", "audio"]);
  });

  test("does not touch the list when the modalities were already corrected", () => {
    // Partial repair: a config whose modalities are right but whose list still names the model
    // must not be rewritten, because the exact-match guard is what keeps this migration honest.
    const projection = projectStaleVisionClassifications(
      staleConfig({ [MODEL]: ["text", "image"], [SIBLING]: ["text"] }),
    );
    expect(projection.changed).toBe(false);
    expect(projection.config.providers!["opencode-go"]!.noVisionModels).toContain(MODEL);
  });

  test("skips a row that no longer carries the registry adapter", () => {
    const projection = projectStaleVisionClassifications(staleConfig(undefined, undefined, "anthropic"));
    expect(projection.changed).toBe(false);
  });

  test("is a no-op on a config without the provider", () => {
    const projection = projectStaleVisionClassifications({ providers: {} } as unknown as OcxConfig);
    expect(projection.changed).toBe(false);
    expect(projection.warnings).toEqual([]);
  });

  test("every entry names a real correction the registry now carries", () => {
    // Guards against an entry that repairs a value the registry never claimed, or one whose
    // target the registry does not declare — either would be a silent no-op forever.
    for (const entry of STALE_VISION_CLASSIFICATIONS) {
      const registry = PROVIDER_REGISTRY.find(row => row.id === entry.provider);
      expect(registry, entry.provider).toBeDefined();
      expect(registry?.modelInputModalities?.[entry.model], entry.model).toEqual(entry.toModalities);
      expect(registry?.noVisionModels ?? [], entry.model).not.toContain(entry.model);
      expect(entry.fromModalities).not.toEqual(entry.toModalities);
    }
  });
});
