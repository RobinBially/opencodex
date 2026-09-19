/**
 * An explicit custom row outranks the provider-level vision hints.
 *
 * The reported defect: a model the operator had added as a manual custom row with
 * `inputModalities: ["text", "image"]` still had every attachment replaced by the omission
 * marker. The catalog half was already correct — `src/codex/catalog/routed-gather.ts` copies
 * `customModels[].inputModalities` onto the advertised row, which is why the dashboard showed
 * "text, image" — while the request path consulted only `providers[].noVisionModels` and
 * `modelInputModalities` and concluded text-only. One config, two answers.
 *
 * These tests pin the precedence at the request-path seam (`requiresVisionPreprocessing`) and at
 * the shared capability predicate (`modelAcceptsImageInput` / `isVisionSidecarConsumer`), which
 * is what the sidecar picker and the web-search verbalizer read.
 */
import { describe, expect, test } from "bun:test";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import {
  isVisionSidecarConsumer,
  modelAcceptsImageInput,
} from "../../src/vision/eligibility";
import { requiresVisionPreprocessing } from "../../src/vision/plan";

const PROVIDER = "zen-go";
const MODEL = "deepseek-v4.1-flash";

/** The reported shape: the provider lists the model as text-only, the custom row says otherwise. */
const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://opencode.ai/zen/go/v1",
  noVisionModels: [MODEL],
  modelInputModalities: { [MODEL]: ["text"] },
};

function configWith(
  customModels?: OcxConfig["customModels"],
  providerOverrides: Partial<OcxProviderConfig> = {},
): OcxConfig {
  return {
    port: 10100,
    defaultProvider: PROVIDER,
    providers: { [PROVIDER]: { ...provider, ...providerOverrides } },
    ...(customModels ? { customModels } : {}),
  } as OcxConfig;
}

const imageRow: NonNullable<OcxConfig["customModels"]>[number] = {
  id: "custom-image-row",
  provider: PROVIDER,
  modelId: MODEL,
  inputModalities: ["text", "image"],
};

describe("custom row outranks provider vision hints", () => {
  test("the provider hints alone are what strip the image (the reported defect)", () => {
    const config = configWith();
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(true);
    expect(modelAcceptsImageInput(config, { provider: PROVIDER, id: MODEL })).toBe(false);
  });

  test("an explicit image declaration on the custom row turns preprocessing off", () => {
    const config = configWith([imageRow]);
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(false);
    expect(modelAcceptsImageInput(config, { provider: PROVIDER, id: MODEL })).toBe(true);
  });

  test("the shared consumer predicate agrees, so the picker and verbalizer follow", () => {
    expect(isVisionSidecarConsumer(configWith([imageRow]), PROVIDER, MODEL)).toBe(false);
    expect(isVisionSidecarConsumer(configWith(), PROVIDER, MODEL)).toBe(true);
  });

  test("an explicit text-only custom row outranks provider hints that advertise image", () => {
    // The mirror direction: the row must be able to declare text-only for a model the provider
    // row happens to describe as image-capable, or the override would only work one way.
    const config = configWith(
      [{ ...imageRow, inputModalities: ["text"] }],
      { noVisionModels: [], modelInputModalities: { [MODEL]: ["text", "image"] } },
    );
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(true);
    expect(modelAcceptsImageInput(config, { provider: PROVIDER, id: MODEL })).toBe(false);
  });

  test("a custom row without a modality declaration stays silent instead of claiming text-only", () => {
    const config = configWith(
      [{ id: "custom-row", provider: PROVIDER, modelId: MODEL, contextWindow: 1_048_576 }],
      { noVisionModels: [], modelInputModalities: { [MODEL]: ["text", "image"] } },
    );
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(false);
    expect(modelAcceptsImageInput(config, { provider: PROVIDER, id: MODEL })).toBe(true);
  });

  test("modelCapabilities remains the top slot when it contradicts the custom row", () => {
    // `modelCapabilities` is the dedicated capability axis and what `ocx provider edit --text-only`
    // writes. Two explicit declarations that disagree resolve to the more specific axis.
    const config = configWith([imageRow]);
    config.providers[PROVIDER]!.modelCapabilities = { [MODEL]: { inputModalities: ["text"] } };
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(true);
    expect(modelAcceptsImageInput(config, { provider: PROVIDER, id: MODEL })).toBe(false);
  });

  test("a custom row for a different provider or model id does not leak", () => {
    const otherProvider = configWith([{ ...imageRow, provider: "other-provider" }]);
    expect(requiresVisionPreprocessing(otherProvider, otherProvider.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(true);
    const otherModel = configWith([{ ...imageRow, modelId: "another-model" }]);
    expect(requiresVisionPreprocessing(otherModel, otherModel.providers[PROVIDER]!, MODEL, PROVIDER)).toBe(true);
  });

  test("without a providerName the custom row is not consulted, preserving legacy callers", () => {
    // The provider-only fallback exists for unit callers that never resolved a route. It must not
    // start guessing which provider a bare model id belongs to.
    const config = configWith([imageRow]);
    expect(requiresVisionPreprocessing(config, config.providers[PROVIDER]!, MODEL)).toBe(true);
  });
});
