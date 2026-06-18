# Stage 4 — Fine-tune playbook (deep dive)

Companion to `SKILL.md`'s Stage 4 sections. Use this for the *why* behind the recipe — hyperparameter rationale, the validated empirical numbers, and when to stop tuning. The *what* (split script, base-model choice, docker invocation, offline eval, riva-build/riva-deploy commands) lives in `SKILL.md` and is not duplicated here.

## Empirical validation

The recipe in `SKILL.md` is verified end-to-end on a reference clinical manifest. The numbers below are the actual measurements, not estimates:

| Manifest | Base model | Recipe | Cycle-1 KER | Cycle-2 KER | Relative reduction |
|---|---|---|---|---|---|
| 39 rows, mixed categories | `nvidia/parakeet-tdt-0.6b-v2` | Stock NeMo SFT, 3 epochs, lr=3e-4, bf16-mixed, batch_size=4 | 0.513 | 0.128 | −75% |

Per-category breakdown on the same manifest (cycle 1 → cycle 2):

| Category | Cycle-1 KER | Cycle-2 KER |
|---|---|---|
| Drug names | 0.857 | 0.214 |
| Conditions | 0.500 | 0.000 |
| Procedures | 0.250 | 0.000 |

Note the asymmetry: drug names start hardest and improve most. Conditions and procedures already had partial coverage in the base model.

## Hyperparameter rationale

The hyperparameter table itself is in `SKILL.md` §4d. The choices below are the *why* — diagnostic notes for tuning, not values to copy.

- **`bf16-mixed` precision is non-negotiable for TDT.** `fp32` works but is ~2× slower. `fp16-mixed` produces NaN losses with TDT decoders — a known TDT numerical-stability issue.
- **`lr=3e-4` is the upper end of the comfortable range.** Below 1e-4, training barely moves on small (<100-row) manifests. Above 1e-3, you risk catastrophic forgetting of the base model's general English vocabulary — recoverable but expensive.
- **`warmup_steps=5` is tiny-manifest-only.** At 1,000+ row scale, bump to ~500 (one epoch's worth of steps). The 5-step value exists because the reference manifest's 39 rows fit in <10 steps total at `batch_size=4`.
- **`epochs=3` is a smoke test.** Production runs use 10–30 epochs with early-stopping on validation WER (`patience=3`). The 3-epoch verified result reflects how quickly TDT picks up clinical vocabulary once the override SSML has gotten the audio right.
- **`batch_size=4` fits a 16 GB VRAM GPU.** On 48 GB cards (L40S, A6000), raise to 16. Effective batch size also scales via `accumulate_grad_batches` if you're OOM-constrained — this is the right escape hatch on 24 GB cards when bs=8 is needed but bs=8 won't fit.
- **`gradient_clip_val=1.0` is defensive.** With this recipe + the verified base, gradients haven't been observed to explode. Keep it on — the cost is zero, and removing it makes diagnosing rare divergences harder.

## When to stop tuning

A multi-cycle loop has natural stopping points. After cycle N+1, evaluate:

- **You've hit a KER floor across multiple cycles.** Two consecutive cycles with KER drop < 5% relative is the signal to stop tuning and either accept the model or rethink the methodology (add a new metric, extend `entity_category` to capture a missed dimension, etc.).
- **You're past 30 epochs without improvement.** TDT bases plateau by ~30 epochs on manifests under ~5,000 rows. Larger manifests merit larger budgets — but verify scaling laws empirically; don't extrapolate from the 3-epoch smoke run.
- **Validation WER trends upward while training loss drops.** Classic overfit. Bail to `/digital-health-clinical-asr-build` and grow the manifest, or add early-stopping (`patience=3` on validation WER).

## Brev provisioning (full walkthrough)

The condensed Brev recipe in `SKILL.md` §4a is enough for the happy path. This section covers the *why* and the corners — disk sizing, SKU selection, install-script verification, and the SSH-config step that trips first-time users.

### Account + cost shape

Create an account at <https://brev.dev>. Brev bills per-second on top of the underlying cloud's SKU rate, so the cost shape is: *(SKU $/hr) × (provision time + active time + idle time before stop)*. The L40S 48 GB SKU runs about $1.50/hr at the time of writing; a 3-epoch SFT run on a ~100-row manifest finishes in 15–30 minutes, so the run itself is under a dollar. The trap is **forgetting to stop the instance** after the run — overnight idle on an L40S is ~$36. Set a calendar reminder, or wrap the whole flow in a script that ends with `brev stop`.

### Verifying the Linux install script

The Brev install script is hosted on `raw.githubusercontent.com/brevdev/brev-cli/main/bin/install-latest.sh`. The `curl | sh` antipattern hands arbitrary code execution to whoever controls that URL (Brev's GitHub repo + GitHub's CDN). Mitigations:

1. **Download first, run second** (the SKILL.md §4a recipe). `curl -o install-brev.sh` separates fetch from execute; `shasum -a 256` and `less` let you verify before running.
2. **Pin to a release** if your org policy requires reproducibility. The script's URL with `main` follows HEAD; replacing `main` with a tag (`v0.6.420` or whatever's current) freezes the binary. Find the current tag at <https://github.com/brevdev/brev-cli/releases>.
3. **Use Homebrew on macOS.** Homebrew installs from a tap with package-level integrity guarantees; prefer it over the curl path on Mac.

### SKU selection

L40S 48 GB is the right default for Parakeet TDT 0.6B SFT — raises `batch_size` to 16 (vs. 4 on a 24 GB card) and cuts wall-clock proportionally. Step up when:

| When | SKU |
|---|---|
| Parakeet TDT 0.6B, default recipe | `l40s:1` (48 GB) — recommended |
| Parakeet TDT 0.6B, ultra-cheap smoke run | `a10g:1` (24 GB) — drops `batch_size` to 4, longer wall-clock |
| Parakeet 1.1B base | `a100:1` (40 GB or 80 GB) |
| Multi-GPU DDP (rare at this scale) | `a100:2` or `h100:1` |

The current SKU catalog: <https://docs.brev.dev/gpus>.

### Disk sizing

`--disk 200gi` is enough for: NeMo container (~12 GB), 1–2 cycles of audio (~5 GB each at 16 kHz mono on ~200-row manifests), the base `.nemo` (~2 GB), and the trained `.nemo` (~2 GB). Bump to 400 GB if you're keeping multiple cycles on the instance, or if your audio is 48 kHz.

### Image choice

`--image ubuntu-22-04-cuda-12-4` is the only image you should pick for this flywheel. It pre-bakes:
- NVIDIA driver compatible with CUDA 12.4
- Docker + NVIDIA Container Toolkit (covers `/riva-nim-setup` prereqs)
- `nvidia-smi` works out of the box

Vanilla Ubuntu images need driver + toolkit install before `nvcr.io/nvidia/nemo:25.11.01` can use the GPU — solvable, but wasted setup time at $1.50/hr.

### SSH-config + rsync (the step that trips first-timers)

Brev exposes each instance over SSH, but the connection details aren't in `~/.ssh/config` by default. The fix is one command:

```bash
brev ssh-config            # writes Host entries to ~/.ssh/config
ssh digital-health-clinical-asr-sft  # or: rsync -avz ./cycle1/ digital-health-clinical-asr-sft:~/cycle1/
```

After `brev ssh-config`, the instance name works as a standard SSH host. Skip this command and `rsync` will fail with `ssh: Could not resolve hostname digital-health-clinical-asr-sft`.

### Stopping vs deleting

- `brev stop <name>` — halts billing for compute, **keeps the disk** (and its $0.10/GB-month storage cost). Use between training sessions on the same cycle.
- `brev delete <name>` — frees everything. Use when you're done with a cycle and have rsync'd the artifacts back to your laptop.

If you have a recurring training cadence (e.g. one cycle a week), `stop` between sessions saves you the `docker pull` + re-rsync each time. If cycles are one-offs, `delete` is cleaner.

## Container invocation (full docker-run pattern from SKILL.md §4d)

Paths are illustrative — adapt to your cycle layout. The flag set encodes the hyperparameters from the SKILL.md §4d table.

```bash
docker run --gpus all --rm -it \
  -v "$PWD:/workspace" \
  nvcr.io/nvidia/nemo:25.11.01 \
  python /opt/NeMo/examples/asr/speech_to_text_finetune.py \
    --config-path=conf \
    --config-name=speech_to_text_finetune \
    model.train_ds.manifest_filepath=/workspace/train.jsonl \
    model.validation_ds.manifest_filepath=/workspace/validation.jsonl \
    init_from_pretrained_model=nvidia/parakeet-tdt-0.6b-v2 \
    trainer.precision=bf16-mixed \
    trainer.max_epochs=3 \
    model.optim.lr=3e-4 \
    model.optim.sched.warmup_steps=5 \
    model.train_ds.batch_size=4 \
    trainer.gradient_clip_val=1.0
```

## Related references

- Base-model selection table → `SKILL.md` §4c
- Stock SFT hyperparameter values → `SKILL.md` §4d
- Decision tree on cycle-N+1 KER → `SKILL.md` §4e
- `riva-build` / `riva-deploy` commands → `SKILL.md` §4f
- Host → container manifest path rewriting → `SKILL.md` "References" section (links `container-paths.md` from the top level)
