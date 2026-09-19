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
 * Correcting the registry therefore fixes new installs only. This projection is the other half.
 * It repairs the two saved values a stale seed left behind, in both states that reach a running
 * process:
 *
 * - the full pair: modalities still exactly the stale declaration, and the id in the list. Both
 *   are rewritten.
 * - the half-repaired row: modalities already corrected but the id still in the list. The
 *   sidecar predicate reads `noVisionModels` BEFORE the modality list, so that row keeps
 *   stripping images until the name goes as well; this projection removes it and leaves the
 *   modalities untouched.
 *
 * The paired modalities value is the guard in both states, which is also why it has to be
 * readable: a name in the list with no modality declaration beside it is ambiguous — either a
 * half-finished repair or an entry the operator added on purpose — and this projection does not
 * guess which. It leaves that row alone.
 *
 * Nothing here writes `modelCapabilities`. That is the dedicated per-model axis, it outranks
 * every source this file touches, and it is where a deliberate text-only override belongs
 * (`ocx provider edit <provider> --model <id> --text-only` writes it).
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
    const modalities = prov.modelInputModalities;
    if (!modalities) continue;
    // The paired modalities value is the guard, and it decides which of the two states above this
    // row is in. Anything else is a declaration this file does not own.
    const saved = modalities[entry.model];
    const stale = sameModalities(saved, entry.fromModalities);
    const alreadyMigrated = sameModalities(saved, entry.toModalities);
    if (!stale && !alreadyMigrated) continue;
    const visionList = Array.isArray(prov.noVisionModels) ? prov.noVisionModels : undefined;
    const listed = visionList !== undefined && visionList.includes(entry.model);
    // Half-repaired rows have nothing left to do once the name is gone; the full pair is rewritten
    // whether or not the name was ever listed, because `derive.ts` fills the two fields
    // independently and a per-key modality fill can land without the all-or-nothing list.
    if (!stale && !listed) continue;
    if (stale) modalities[entry.model] = [...entry.toModalities];
    if (visionList !== undefined && listed) {
      prov.noVisionModels = visionList.filter(id => id !== entry.model);
    }
    const repairedList = repaired.get(entry.provider) ?? [];
    repairedList.push(stale
      ? `${entry.model} ${entry.fromModalities.join("+")} -> ${entry.toModalities.join("+")}`
      : `${entry.model} dropped from noVisionModels (modalities already ${entry.toModalities.join("+")})`);
    repaired.set(entry.provider, repairedList);
  }

  for (const [provider, list] of repaired) {
    warnings.push(
      `repaired the stale registry vision seed for ${list.length} model(s) on "${provider}": `
      + `${list.join(", ")}.`,
    );
  }

  return { config, changed: repaired.size > 0, warnings };
}
