---
name: "digital-health-clinical-asr-finetune"
description: "Stage 4 of the Clinical ASR Flywheel. Use when priority KER is above 0.3 to run stock NeMo SFT on Parakeet TDT v2 and offline cycle N+1 re-eval. NOT for generic word boosting (use /finetune-asr)."
version: "1.0.0"
author: "Ben Randoing <brandoing@nvidia.com>"
tags:
  - clinical-asr
  - finetune
  - sft
  - nemo
  - parakeet
  - flywheel
tools:
  - Read
  - Write
  - Bash
  - Skill
license: Apache-2.0
compatibility: "Requires a CUDA host (24 GB VRAM comfortable, 16 GB workable with batch_size=4), the NeMo container (nvcr.io/nvidia/nemo:25.11.01), and the finetune-asr + riva-asr-custom skills installed alongside this one. No local GPU? Use Brev. NVIDIA_API_KEY required for the offline cycle N+1 eval round-trip and for any NIM deploy."
metadata:
  author: "Ben Randoing <brandoing@nvidia.com>"
  tags:
    - clinical-asr
    - flywheel
    - finetune
    - nemo-sft
    - parakeet
  team: healthcare-tme
  domain: ai-ml
  stage: 4
  previous_skill: digital-health-clinical-asr-eval
  next_skill: riva-asr-custom
---

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Clinical ASR Flywheel — Stage 4 (Fine-tune)

> **⚠ Agent: read this entire SKILL.md before answering.** The Critical-workflow-rules section, the base-model table (§4c), the stock-NeMo-SFT recipe (§4d), and the cycle-N+1 decision table (§4e) are all load-bearing — the do-not-SFT bases and broken-adapter warnings live there.

> **Agent: this file is self-contained.** The Stage 4 gate criteria, base-model recommendation, hyperparameter table, container invocation pattern, and cycle-N+1 decision table are all below. **Do not** run file-discovery commands or open `references/stage4-finetune.md` before answering methodology questions — the reference is deep-dive material, not required reading. Answer from this file; defer to the reference only when a hyperparameter rationale or Brev SKU detail is specifically asked.

You are the **adapt-and-measure** stage. The user arrives from `/digital-health-clinical-asr-eval` with a manifest, a baseline KER number, and the decision-tree's recommendation that fine-tuning is worth the GPU time. You run stock NeMo SFT, do an offline cycle N+1 re-eval to **measure that the loop closed**, and optionally hand the resulting `.nemo` to `/riva-asr-custom` for production serving.

**The cycle KER from offline eval is the measurement that closes the loop.** Riva NIM deploy validates serving (latency, streaming, scale), not model quality.

> **Empirically verified on the reference manifest** (39 rows, Parakeet TDT v2):
> Baseline KER **0.513** → after 3 epochs of stock SFT: **0.128** (-75% relative).
> Drug names: 0.857 → 0.214. Conditions: 0.500 → 0.000. Procedures: 0.250 → 0.000.

## Critical workflow rules (apply on every activation)

Surface these facts in any response, even if the user asks a narrow question:

1. **Read this entire SKILL.md before answering.** The base-model selection table, hyperparameter values, and the cycle-N+1 decision table are below — they are the load-bearing parts.
2. **Verified result** — Parakeet TDT v2 with the recipe in §4c achieves **KER 0.513 → 0.128 (−75% relative)** in 3 epochs on the reference manifest. Cite this when the user asks whether SFT will help.
3. **Recipe is `/opt/NeMo/examples/asr/speech_to_text_finetune.py` inside `nvcr.io/nvidia/nemo:25.11.01`.** Stock script, no patches, no custom adapter logic. The adapter-mixin path is broken on TDT/RNNT decoders (72 NaN tensors at any LR) — do not propose it.
4. **Recommended base is `nvidia/parakeet-tdt-0.6b-v2`.** The full base-model table is in §4c.
5. **Do NOT fine-tune `nvidia/nemotron-speech-streaming-en-0.6b`.** The streaming NVCF function's SFT path is broken (UNK collapse on validation after step 1). For streaming serving at deploy time, Riva chunks a non-streaming base just fine. Warn the user proactively if they propose it.
6. **Gate the recommendation.** Stage 4 only fires when priority-category KER > 0.3 **and** manifest has ≥ 100 rows (≥ 5 per priority category). Below those thresholds, route back to `/digital-health-clinical-asr-build` to grow the manifest first.

## Purpose

Run **stock NeMo SFT** (no custom adapter logic, no patches) in `nvcr.io/nvidia/nemo:25.11.01` against a term-aware row-disjoint train/val split, produce a `.nemo` model, and re-eval offline as cycle N+1. Decide based on the cycle-N → cycle-N+1 KER delta whether to keep the model, grow the manifest, or accept that fine-tuning didn't help. Optionally hand the `.nemo` to `/riva-asr-custom` for NIM deploy.

## When to use this skill

Activate on user phrases like:

- "Fine-tune ASR on my clinical vocabulary"
- "Improve ASR on medication names"
- "We have a KER of 0.4, can we fine-tune?"
- "Run SFT on my Parakeet TDT base"
- "Train a clinical ASR adapter"
- "Compare cycle 1 vs cycle 2 KER"
- "Deploy my fine-tuned model as a NIM" *(this skill prepares the `.nemo` and routes to `/riva-asr-custom` for the deploy)*

Do **not** activate when:

- The user hasn't scored a baseline yet → `/digital-health-clinical-asr-eval`
- The user doesn't have a manifest → `/digital-health-clinical-asr-build`
- The user wants generic word boosting / LM fusion (not SFT) → `/finetune-asr`
- The user has a `.nemo` and only wants to deploy → `/riva-asr-custom`

## Prerequisites

- **A cycle-N manifest + cycle-N eval result** from `/digital-health-clinical-asr-eval`. The priority-category KER must be > 0.3 (Stage 4 gate). The manifest should have ≥ 100 rows total, and ≥ 5 rows per priority `entity_category`, for a believable post-tune signal.
- **A CUDA host** — 24 GB VRAM is comfortable for Parakeet TDT 0.6B at `batch_size=4` with `bf16-mixed`; 16 GB works with smaller batch. No local GPU? Use Brev — recommended SKU is L40S 48 GB.
- **The NeMo container**: `nvcr.io/nvidia/nemo:25.11.01`. Pull once: `docker pull nvcr.io/nvidia/nemo:25.11.01`.
- **NVIDIA Container Toolkit + Docker** — covered by `/riva-nim-setup` if not already installed.
- **A train/val split** stratified by `entity_category` (recipe sketch in Step 4b below).
- **`/riva-asr-custom`** installed if you intend to deploy. Pure-research SFT runs without it.

## Instructions

### 4a. Provision a GPU host (skip if you already have one)

Stage 4 needs a CUDA host with ≥ 16 GB VRAM (24 GB comfortable). If you have a local one that fits, skip this section. If not, use **Brev** — NVIDIA's per-second-billed GPU host service. Recommended SKU: L40S 48 GB.

**Cost disclosure — surface this to the user before any `brev create`.** L40S 48 GB runs ~$1.50/hr at time of writing; a 3-epoch SFT run on a 100-row manifest finishes in 15–30 minutes (~$0.40–$0.75 of compute). The real risk is **forgetting to stop the instance** — overnight idle on L40S is ~$36, a week of idle is ~$250. Mitigations: (a) always wrap the workflow in a script that ends with `brev stop`; (b) set a calendar reminder when you start; (c) `brev delete` instead of `brev stop` if you don't need to keep the disk (`stop` keeps disk at $0.10/GB-month — 200 GB ≈ $20/month of latent cost). Confirm the user accepts the per-hour cost shape and the idle risk before spinning anything up.

Full setup walkthrough — CLI install (download-then-run, not curl-pipe), SKU choice, disk sizing, SSH config — is in `references/stage4-finetune.md` (§Brev provisioning).

Short happy-path once the CLI is installed. **Do not run `brev create` until the user has explicitly typed `YES` at the confirmation prompt below** — the gate is mandatory, not advisory, because everything after it bills against the user's account by the second:

```bash
brev login                                  # browser auth

# Mandatory cost-confirmation gate — do NOT skip or auto-answer this.
echo "About to provision: digital-health-clinical-asr-sft on L40S 48 GB."
echo "Cost shape: ~\$1.50/hr while running; ~\$36/night if left idle; ~\$20/mo disk if you 'stop' instead of 'delete'."
read -rp "Type YES to provision (anything else cancels): " confirm
[ "$confirm" = "YES" ] || { echo "Cancelled — no GPU instance was created."; exit 1; }

brev create digital-health-clinical-asr-sft \
  --gpu l40s:1 --image ubuntu-22-04-cuda-12-4 --disk 200gi
brev ssh-config                             # writes ~/.ssh/config entries
rsync -avz ./cycle1/ digital-health-clinical-asr-sft:~/cycle1/
brev shell digital-health-clinical-asr-sft            # drops into the instance
nvidia-smi                                  # confirm GPU
docker pull nvcr.io/nvidia/nemo:25.11.01    # ~12 GB, once per instance
```

When done, **always halt billing**: `brev stop digital-health-clinical-asr-sft` (keeps disk) or `brev delete digital-health-clinical-asr-sft` (frees it). For path rewriting laptop → Brev → NeMo container, see `references/container-paths.md`.

### 4b. Term-aware train/val split

**Row-disjoint, stratified by `entity_category`, default val fraction 0.2.**

The **same `term`** may appear on both sides via different rows (different voice, context, noise). That's expected and desirable — it measures acoustic + contextual robustness on the trained vocabulary, which is the standard ASR adaptation metric.

Singleton categories (one row total) get forced to train with a warning. If any priority category has < 5 rows, **bail to `/digital-health-clinical-asr-build`** — held-out validation will be too noisy to attribute movement.

Sketch:

```python
# After loading manifest.jsonl into a list of dicts `rows`:
from collections import defaultdict
import random
random.seed(42)

by_cat = defaultdict(list)
for r in rows:
    by_cat[r["entity_category"]].append(r)

train, val = [], []
for cat, cat_rows in by_cat.items():
    random.shuffle(cat_rows)
    if len(cat_rows) < 2:
        train.extend(cat_rows)
        print(f"warning: singleton category {cat}, forced to train")
        continue
    n_val = max(1, int(0.2 * len(cat_rows)))
    val.extend(cat_rows[:n_val])
    train.extend(cat_rows[n_val:])
```

Write `train.jsonl` and `validation.jsonl` alongside the manifest. **These are the inputs to `speech_to_text_finetune.py`.**

### 4c. Choose the base model

| Base | SFT viability | Notes |
|---|---|---|
| **`nvidia/parakeet-tdt-0.6b-v2`** | ✅ **Empirically verified** (KER 0.513 → 0.128 in 3 epochs, −75% relative) | NVIDIA's current English ASR default. Stock NeMo SFT recipe works end-to-end. **Recommended.** |
| `nvidia/nemotron-speech-streaming-en-0.6b` | ❌ **Don't use for SFT** | NVCF function is streaming-only; SFT path unreliable (UNK collapse on validation after first training step). For streaming serving, Riva chunks a non-streaming base just fine. |

Other Parakeet/Conformer bases (1.1B, CTC, RNNT, `stt_en_conformer_ctc_large`) + decoder → NIM container mapping: `references/stage4-finetune.md`. If the user asks to fine-tune Nemotron Speech Streaming, **warn about the collapse and recommend Parakeet TDT v2**.

### 4d. Stock NeMo SFT

In the NeMo container, invoke `/opt/NeMo/examples/asr/speech_to_text_finetune.py` directly. **No custom adapter logic. No patches.** The stock NeMo SFT script is the verified working recipe.

Hyperparameters (verified on Parakeet TDT v2, 39-row manifest):

```
init_from_pretrained_model: nvidia/parakeet-tdt-0.6b-v2
precision:                  bf16-mixed       # required for TDT numerical stability
lr:                         3e-4             # CosineAnnealing schedule
warmup_steps:               5                # tiny manifest; bump to 500 at production scale
epochs:                     3                # smoke; 10-30 for production
batch_size:                 4                # fits 16 GB VRAM; raise to 16 on L40S 48 GB
gradient_clip_val:          1.0              # defensive
```

**Container invocation**: `docker run --gpus all --rm -it -v "$PWD:/workspace" nvcr.io/nvidia/nemo:25.11.01 python /opt/NeMo/examples/asr/speech_to_text_finetune.py` with `model.train_ds.manifest_filepath=/workspace/train.jsonl`, `model.validation_ds.manifest_filepath=/workspace/validation.jsonl`, `init_from_pretrained_model=nvidia/parakeet-tdt-0.6b-v2`, and the hyperparameter overrides from the table above. Full docker-run line with config-path / config-name flags: `references/stage4-finetune.md` §Container invocation.

**Manifest paths inside the container.** Host paths (e.g. `$HOME/…`) don't resolve in `/workspace`. Rewrite snippet: `references/container-paths.md`.

The training run writes `adapted_model.nemo` and a `training_run_info.json` summary. Both go into a per-cycle subdirectory of the user's choice (e.g. `cycle<N>/models/<run>/`; the layout doesn't matter as long as it's consistent across cycles).

### 4e. Offline cycle N+1 eval — close the loop

Re-transcribe the cycle's audio with the fine-tuned `.nemo` using NeMo's offline `transcribe()`. **No Riva needed** — this is measurement, not serving. NeMo's offline path runs the same encoder + decoder graph the Riva NIM eventually serves.

Sketch:

```python
import nemo.collections.asr as nemo_asr
model = nemo_asr.models.ASRModel.restore_from("adapted_model.nemo")
hyps = model.transcribe(["audio/row1.wav", "audio/row2.wav", ...])
```

Score the same four metrics (WER/CER/KER/SER) and the same five-section leaderboard the eval skill produces. Write them as `leaderboard_cycle<N+1>.md`. Compare against `leaderboard_cycle<N>.md`.

**Decision table** — cycle-N+1 vs cycle-N:

| Result | Action |
|---|---|
| KER dropped meaningfully on targeted categories (e.g. drug KER −20% or more, relative) | ✅ Keep the `.nemo`. Update the leaderboard. Advance to Step 4f if you want to deploy. |
| KER moved a little, you wanted more | Loop back to `/digital-health-clinical-asr-build`, expand the manifest. Tiny manifests rarely benefit from hyperparameter tweaks — signal density beats LR sweeps. |
| KER got worse | Overfit on a tiny manifest. Bail to `/digital-health-clinical-asr-build` and grow before retraining. Don't tune harder on the same data. |
| No measurable change | Some categories may already be in the base model's vocab. Sanity-check per-category numbers before concluding training "didn't help." |

### 4f. (Optional) Deploy as a Riva NIM

Hand the `.nemo` to `/riva-asr-custom`. **Pass the source architecture explicitly** — `/riva-asr-custom` can't reliably detect CTC vs RNNT vs TDT from the `.nemo` alone, and the wrong NIM container produces a broken RMIR with no clear error:

| Source decoder | `riva-build` flag | NIM container family |
|---|---|---|
| Conformer-CTC | `decoder=greedy_ctc` | `parakeet-*-ctc-*` |
| Conformer-RNNT | `decoder=nemo` | `parakeet-rnnt-*` |
| **Conformer-TDT (default)** | `decoder=nemo` | `parakeet-tdt-*` |
| Cache-Aware RNNT (Nemotron streaming) | `decoder=nemo` | `nemotron-streaming-*` ⚠ SFT broken on this base, see Limitations |

After deploy: re-run `/digital-health-clinical-asr-eval` against the new endpoint (`ASR_ENDPOINT=localhost:50051`) to validate that production-serving numbers match offline numbers. Any divergence is in Riva preprocessing or `riva-build` flags, not the model. Route to `/riva-asr-custom`.

## Examples

**Scenario A — gate met.** User: *"Drug KER 0.42, 130 rows. SFT?"* → Yes (gate cleared). `parakeet-tdt-0.6b-v2` (verified 0.513 → 0.128). No local GPU? Step 4a (Brev) → 4b (split) → 4d (stock SFT) → 4e (offline re-eval). If cycle-2 drug KER drops ≥ 20% relative, keep the `.nemo`; otherwise back to `/digital-health-clinical-asr-build`.

**Scenario B — Nemotron Streaming.** User: *"SFT `nvidia/nemotron-speech-streaming-en-0.6b`?"* → No (UNK collapse). Substitute `parakeet-tdt-0.6b-v2`. Riva chunks non-streaming bases for streaming serving — base doesn't need to be streaming-native.

**Scenario C — cycle 2 KER unchanged.** User: *"KER barely moved."* → Back to `/digital-health-clinical-asr-build`. Signal density beats LR sweeps. If `magpie_g2p` rows are bad but `merriam-webster` rows are good, the gap is pronunciation-coverage — `/digital-health-clinical-asr-build` Step 2d.

## Artifacts produced

- `train.jsonl`, `validation.jsonl` — term-aware split (Step 4b)
- `adapted_model.nemo` — fine-tuned model (Step 4d)
- `training_run_info.json` — hyperparameters, dataset stats, end-of-train metrics
- `offline_hyps.jsonl` — cycle-N+1 transcription hypotheses (Step 4e)
- `leaderboard_cycle<N+1>.md` — cycle-N+1 five-section leaderboard
- *(optional, after Step 4f)* a deployed NIM endpoint (delegated to `/riva-asr-custom`)

## Troubleshooting

- **Stage 4 training collapses to all-UNK after first step** → you're on the cache-aware streaming RNNT base (`nemotron-speech-streaming-en-0.6b`). Route to `nvidia/parakeet-tdt-0.6b-v2` (the recommended default) or `nvidia/stt_en_conformer_ctc_large` (legacy fallback). The streaming RNNT SFT path is broken; do not retry with different hyperparameters.
- **Manifest paths don't resolve inside the NeMo container** → host paths (e.g. `$HOME/…`) need rewriting to `/workspace/…`. See `references/container-paths.md` for the rewrite snippet.
- **Cycle N+1 KER unchanged from cycle N** → on `parakeet-tdt-0.6b-v2` with the recipe above, this almost always means **manifest signal density is too low**. Grow the manifest first; don't sweep LR. (If you're on an older adapter-style recipe instead of stock SFT, the adapter weights may not have moved off zero-init — switch to stock SFT.)
- **Cycle N+1 KER got worse** → overfit on a tiny manifest. Bail to `/digital-health-clinical-asr-build` and grow.
- **Riva-served numbers diverge from offline numbers** → the gap is in Riva preprocessing or `riva-build` flags, not the model. Route to `/riva-asr-custom`.
- **`bf16-mixed` precision errors** → some GPUs (older Turing, all Volta) don't support BF16. Drop to `fp32` and reduce `batch_size`. Use `fp16-mixed` only if `fp32` is too slow — fp16 with TDT decoders can produce NaN losses, so check loss curves early.
- **OOM during training on 24 GB GPU** → drop `batch_size` to 2, raise `accumulate_grad_batches` to 2 to keep the effective batch size constant.

## Limitations

- **Adapter-style SFT on TDT/RNNT decoders is broken.** Empirically confirmed: an earlier LinearAdapter-mixin recipe produces 72 NaN tensors at any LR on TDT and RNNT decoders. Resolved by switching to NeMo's **stock full-model SFT** (`speech_to_text_finetune.py`) — which is what this skill recommends. Do not attempt adapter SFT on TDT/RNNT bases.
- **Don't SFT `nemotron-speech-streaming-en-0.6b`.** The streaming-only NVCF function's SFT path is unreliable (UNK collapse). For streaming serving at deploy time, Riva chunks a non-streaming base.
- **Tiny manifests overfit fast.** Below ~100 rows total or ~5 rows per priority category, cycle-N+1 numbers are noisy. Grow before trusting a small KER drop.
- **English-only by default.** The base-model table is en-US-specific. Other locales need a different base + a re-validated SFT recipe.
- **No turn-key driver.** The user writes their own training-driver layout — output paths, run naming, leaderboard re-rendering. The methodology and recipes transfer; exact cycle-1 numbers depend on the user's manifest.

## Next steps

- **Deploy the `.nemo` as a NIM:** `/riva-asr-custom` (pass the source architecture explicitly).
- **Grow the manifest for cycle N+2:** `/digital-health-clinical-asr-build`.
- **Re-score the cycle:** `/digital-health-clinical-asr-eval` (against the new endpoint or the new `.nemo` directly).
- **Lateral** for word boosting / LM fusion / non-clinical SFT recipes: `/finetune-asr`.

## References

- [`references/stage4-finetune.md`](references/stage4-finetune.md) — base-model selection table, hyperparameter rationale, decoder → NIM container mapping, decision tree comparing cycle-N+1 to cycle-N
- [`references/container-paths.md`](references/container-paths.md) — host → `/workspace/` path rewriting for cross-host manifest portability (laptop ↔ Brev ↔ NeMo container)


