# 260911 — Raw reasoning rides the content channel

## Problem

Codex desktop renders the one-line animated thinking band from the Responses summary channel.
Commit 318315450 (issue #45) routed every raw `reasoning_raw_delta` into that summary channel so
non-OpenAI providers got an "expandable" trace, but the summary text there is the model's raw
chain of thought — GLM/DeepSeek/Grok chat streams scrolled unsummarized CoT through the band,
which only looks right for native OpenAI providers that author real summaries.

## Change

- `src/bridge.ts`: visible raw reasoning now streams on the CONTENT channel
  (`response.reasoning_text.delta`, `content_index: 0`) and the final reasoning item carries
  `content: [{type: "reasoning_text", text}]` with an empty `summary` — the native gpt-oss shape
  documented in `100_codex-native-parity/51_raw-reasoning-bridge`. Codex applies its own display
  policy: the desktop band shows the "Thinking…" placeholder, and the CLI still gates raw display
  behind `show_raw_agent_reasoning`.
- Deleted the content-to-summary payload rewrite
  (`src/server/responses-reasoning-summary-rewrite.ts`). Its only purpose was that display;
  native Responses passthrough (DeepSeek) now round-trips content-channel reasoning unchanged,
  which the upstream already accepts.
- Hidden mode (`hideThinkingSummary`, summary absent/"none") is unchanged: envelope-only item with
  txt-only `ocxr1:` round-trip for `preserveReasoningContentModels` replay.
- Claude/kiro SIGNED `thinking_delta` visible mode is intentionally unchanged (summary channel);
  the same content-channel treatment is a possible follow-up.

## Verification

- `bun run typecheck`; focused bridge, raw-reasoning, replay, xAI, web-search, and layout tests.
- The two web-search tests that fail only in multi-file batch runs fail identically on the
  pre-change tree (pre-existing cross-file contamination, not caused here).
