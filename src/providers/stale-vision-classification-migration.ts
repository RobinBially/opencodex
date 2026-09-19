/**
 * Repair vision classifications a saved config inherited from a stale registry seed.
 *
 * `enrichProviderFromRegistry` is fill-only and asymmetric, which is right for a hand-tuned
 * value but freezes a wrong one:
 *
 * - `noVisionModels` is filled ALL-OR-NOTHING (`if (!prov.noVisionModels && seed.noVisionModels)`),
 *   so a config saved while the list was current keeps that list forever.
 * - `modelInputModalities` is filled per-key BENEATH the saved value, so a saved `["text"]` for
 *   one id survives every later registry correction.
 *
 * Correcting the registry therefore fixes new installs only. This projection is the other half:
 * it rewrites the two saved values that are still byte-for-byte the stale declaration this file
 * names. A row the operator edited to something else does not match and is left alone.
 *
 * Scope is deliberately one entry. The Go gateway's `deepseek-v4.1-flash` was declared text-only
 * from jawcode metadata and was measured natively multimodal on 2026-09-19 (see the note at that
 * entry in `registry/entries-core.ts`). Its sibling `deepseek-v4-flash` still rejects images
 * upstream, and the sibling Zen tiers (`opencode-zen`, `opencode-free`) could not be probed at
 * all — an unverified tier is not evidence, so neither is touched here.
 */
import { PROVIDER_REGISTRY } from "./registry";
import type { OcxConfig } from "../types";

export interface StaleVisionClassification {
  /** Registry provider id whose saved rows may carry the wrong classification. */
  provider: string;
  model: string;
  /** The stale saved modalities this migration is allowed to replace, and nothing else. */
  fromModalities: string[];
  toModalities: string[];
}

export interface StaleVisionClassificationProjection {
  config: OcxConfig;
  changed: boolean;
  warnings: string[];
}

export const STALE_VISION_CLASSIFICATIONS: readonly StaleVisionClassification[] = [
  {
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    fromModalities: ["text"],
    toModalities: ["text", "image"],
  },
];

function providerStillMatchesRegistry(id: string, adapter: unknown): boolean {
  const entry = PROVIDER_REGISTRY.find(row => row.id === id);
  return entry !== undefined && entry.adapter === adapter;
}

function sameModalities(current: unknown, expected: readonly string[]): boolean {
  return Array.isArray(current)
    && current.length === expected.length
    && current.every((value, index) => value === expected[index]);
}

/** Pure projection. The caller decides whether to persist. */
export function projectStaleVisionClassifications(
  config: OcxConfig,
  entries: readonly StaleVisionClassification[] = STALE_VISION_CLASSIFICATIONS,
): StaleVisionClassificationProjection {
  const warnings: string[] = [];
  const repaired = new Map<string, string[]>();

  for (const entry of entries) {
    const prov = config.providers?.[entry.provider];
    if (!prov) continue;
    if (!providerStillMatchesRegistry(entry.provider, prov.adapter)) continue;
    // The stale modalities value is the guard. A provider whose row no longer carries exactly
    // that declaration was either already corrected or edited by the operator, and either way
    // this migration has no business rewriting it.
    const modalities = prov.modelInputModalities;
    if (!modalities || !sameModalities(modalities[entry.model], entry.fromModalities)) continue;
    modalities[entry.model] = [...entry.toModalities];
    // The list is the other half of the same stale claim: with the entry left in place the
    // sidecar predicate would still short-circuit to text-only before reading the modalities.
    if (Array.isArray(prov.noVisionModels) && prov.noVisionModels.includes(entry.model)) {
      prov.noVisionModels = prov.noVisionModels.filter(id => id !== entry.model);
    }
    const list = repaired.get(entry.provider) ?? [];
    list.push(`${entry.model} ${entry.fromModalities.join("+")} -> ${entry.toModalities.join("+")}`);
    repaired.set(entry.provider, list);
  }

  for (const [provider, list] of repaired) {
    warnings.push(
      `reclassified ${list.length} model(s) on "${provider}" that the saved config inherited `
      + `from a stale registry vision seed: ${list.join(", ")}.`,
    );
  }

  return { config, changed: repaired.size > 0, warnings };
}
