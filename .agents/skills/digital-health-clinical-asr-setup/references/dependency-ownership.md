# Skill boundaries — what this skill family owns vs. what it defers

The Clinical ASR Flywheel skill family is **glue + methodology**. Most of the deep work composes other skills in the public NVIDIA skills catalog. When something breaks, route to the right skill — don't open an issue against `digital-health-clinical-asr-*` for a TTS pronunciation bug. (ASR transcription used to defer entirely; as of v1.1, the offline-gRPC call shape is **inlined** in the eval skill's Stage 3 Step 3b. For deeper ASR protocol/auth/streaming questions, `/riva-asr` is still the canonical reference.)

## The five external skills this family composes

| Skill | What it provides | Which flywheel stage calls it |
|---|---|---|
| `/riva-tts` (or `/read-aloud`) | TTS synthesis (Magpie, etc.); SSML support | Stage 2 (build) |
| `/riva-asr` | ASR protocol details, model-catalog selection, self-hosted NIM deploy. **Not** called for routine Stage 3 transcription (that's inlined) — only for protocol/auth/streaming/catalog questions. | Stage 3 (eval) reference, Stage 4 (finetune) eval |
| `/finetune-asr` | Word boosting, n-gram LM fusion, generic SFT recipes (non-clinical) | Stage 4 reference + improvement paths |
| `/riva-asr-custom` | `.nemo → .riva → RMIR → deployed NIM` pipeline | Stage 4f (optional deploy) |
| `/riva-nim-setup` | NGC auth, Docker, NVIDIA Container Toolkit | Pre-req for any self-hosted path |
| `/data-designer` | Synthetic sentence generation around term seeds | Stage 2b (sentence gen) |

If the user reports a problem inside any of these, **the right move is to invoke that skill** for diagnosis rather than trying to debug here. Each one carries its own error tables, retry logic, and version-pinning that this family is intentionally not duplicating.

## What the `digital-health-clinical-asr-*` skills own

- The **clinical-ASR methodology** — KER as headline, two-tier IPA tagging, term-aware split, cycle N+1 close-loop.
- The **decision tree** (post-eval) — when to fine-tune vs grow the manifest vs accept the baseline.
- The **manifest schema extension** — the clinical fields (`term`, `entity_category`, `ipa_source`, …) beyond NeMo's required minimum.
- The **base-model selection table** for fine-tune (Parakeet TDT v2 default; streaming-RNNT-collapse warning).
- The **inlined offline ASR gRPC recipe** for routine Stage 3 transcription (with env-var overrides for swap-in models).
- The **composition pattern** — how `/data-designer + /riva-tts + [inlined ASR in eval] + /riva-asr-custom` fit together for a clinical workflow.

## What the `digital-health-clinical-asr-*` skills do **NOT** own

- **TTS pronunciation issues on specific terms** → `/read-aloud` (`/riva-tts`). We provide the SSML override mechanism + IPA validation list; we don't fix the underlying neural G2P.
- **ASR streaming or alternative offline shapes** → `/riva-asr`. The eval skill inlines the simplest offline gRPC call shape ("whole file as one chunk") because clinical sentences are ≤ 30 s; anything beyond that (streaming partials, batching, retry-with-backoff, vendor catalog comparison) lives upstream.
- **NeMo container compatibility, Lhotse loader bugs** → upstream (`/riva-asr-custom` if you're fine-tuning, or the NeMo public issue tracker on GitHub). We document field-tested patterns; we don't promise they'll match future container versions.
- **Riva NIM deploy steps** → `/riva-asr-custom`. We tell the user *which container family* matches their decoder; the deploy mechanics live there.
- **NGC API keys, Docker setup, GPU passthrough** → `/riva-nim-setup`.
- **`NVIDIA_API_KEY` issuance / NVCF function ID rotation** → <https://build.nvidia.com> directly; this family just consumes the key.

## Version pinning (current)

These are the versions the `digital-health-clinical-asr-*` recipes assume. Bump as the upstream skills/models release.

| Component | Version assumed | If you change it |
|---|---|---|
| NeMo container | `nvcr.io/nvidia/nemo:25.11.01` | Re-test the SFT recipe; container ABI may change. See `/riva-asr-custom` for the canonical recipe per container release. |
| Parakeet TDT (default ASR + SFT base) | `nvidia/parakeet-tdt-0.6b-v2` (NVCF function `d3fe9151-…`) | Update `ASR_MODEL_NAME` / `ASR_NVCF_FUNCTION_ID` in env. |
| Magpie TTS | `magpie-tts-multilingual` (NVCF function `877104f7-…`) | Validate SSML phoneme support on the new model — see `/read-aloud` / `/riva-tts`. |
| Nemotron Speech Streaming (eval-only, **don't SFT**) | `nvidia/nemotron-speech-streaming-en-0.6b` | Available for streaming eval; SFT path remains unreliable. |
| `nvidia-riva-client` | `>= 2.x` (Stage 1 + eval recipe assume the renamed `ssl_root_cert` kwarg) | Re-verify the `Auth` constructor signature; it has changed in past major releases. |
| `/riva-tts`, `/riva-asr`, `/finetune-asr`, `/riva-asr-custom`, `/riva-nim-setup`, `/data-designer` | Whatever the current public release is | Re-run a Stage 2 → Stage 3 cycle to confirm nothing broke. |

## When filing issues

This repo accepts contributions per `CONTRIBUTING.md` at the repo root. When you file an issue, include:

1. Which stage skill was active (`digital-health-clinical-asr-setup` / `-build` / `-eval` / `-finetune`).
2. Which external skill was being driven (`/riva-tts`, `/riva-asr`, etc.), or "inlined Stage 3 transcription" if the issue is in the eval skill's recipe.
3. The exact error or symptom — not just "it didn't work."
4. (For Stage 3+) the manifest schema check output from the build skill's `references/manifest-schema.md`.

Most "the flywheel is broken" reports turn out to be `/riva-tts` rate-limits, NVCF function-id rotation (the constants in the inlined recipes go stale when NVIDIA bumps a model), or NeMo container version mismatches. Route correctly the first time.
