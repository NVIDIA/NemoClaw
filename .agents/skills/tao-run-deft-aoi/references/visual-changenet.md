# Visual ChangeNet — DEFT Loop Reference

Read this when the parent runs the `train`, `inference`, or `evaluate` stage. The
underlying skill `tao-skill-bank:tao-train-visual-changenet` (`skills/models/tao-train-visual-changenet/SKILL.md`)
owns the docker invocation, spec format, CSV format, lighting conventions, and error
patterns — its `## Local Docker Invocation` section has the exact docker run command
(including `--shm-size=8g`, backbone file mount, and how to override
checkpoint/results_dir on the command line without editing the spec). This file only
covers the DEFT-loop-specific overlay: mounts, spec paths, two-checkpoint compare,
KPI sweep, and `deft_state.json` / `loop_log.jsonl` updates.

DEFT AOI is intentionally plain-train for Visual ChangeNet. When invoking the
underlying model skill for any train stage, pass `automl_policy: off` so this
workflow bypasses model-level AutoML while leaving Visual ChangeNet metadata
unchanged for other workflows.

## DEFT-Loop Mount Layout

```
-v <workspace>/kpi/images:/data/datasets/NV_PCB_Siamese/images   # covers real + synthetic_iter*
-v <workspace>/train/base:/data/datasets/NV_PCB_Siamese/csv      # training_set.csv, validation_set.csv
-v <workspace>/kpi:/data/datasets/NV_PCB_Siamese/kpi             # testing_set.csv
```

## Spec Key Paths (container-side)

| What | Container path |
|---|---|
| Training CSV (iter N) | `/data/workspace/results/iter${N}/dataset/train_combined_iter${N}.csv` |
| Validation CSV | `/data/datasets/NV_PCB_Siamese/csv/validation_set.csv` |
| KPI test CSV | `/data/datasets/NV_PCB_Siamese/kpi/testing_set.csv` |
| images_dir | `/data/datasets/NV_PCB_Siamese/images` |
| Results dir (iter N) | `/results/iter${N}` |

## Spec `output_dir` Contract

`baseline_spec.yaml` (and every per-iter spec the loop derives from it) **must**
set the train task's `output_dir` to the canonical `<stage>` subdirectory under
the iteration root, **not** to the iteration root itself:

| Task | Required spec `output_dir` |
|---|---|
| baseline train | `${RESULTS_DIR}/baseline/train/` |
| baseline inference | `${RESULTS_DIR}/baseline/inference/` |
| baseline evaluate | `${RESULTS_DIR}/baseline/evaluate/` |
| iter N train | `${RESULTS_DIR}/iter${N}/train/` |
| iter N inference | `${RESULTS_DIR}/iter${N}/inference/` |
| iter N evaluate | `${RESULTS_DIR}/iter${N}/evaluate/` |

Writing to the iteration root (e.g. `${RESULTS_DIR}/baseline/`) causes the
parent's pre-create / checkpoint-discovery / Output Layout (see
`SKILL.md → ## Output Layout`) to diverge from where TAO actually writes,
which manifests as "checkpoint not found" downstream. Edit the spec to match
the table above before launching; do not change the parent's pre-create
convention.

## DEFT Iter Training — Init Convention

For every iteration N≥1, **init from the previous iter's best checkpoint via `train.pretrained_model_path`, not `train.resume_training_checkpoint_path`.**

```bash
# CORRECT for DEFT iter N (fresh epoch counter, weights from prev best)
train.pretrained_model_path=${prev_best_ckpt}

# WRONG for DEFT iter N — Lightning inherits current_epoch from the checkpoint,
# sees current_epoch >= max_epochs (baseline already used up max_epochs),
# and exits with `Trainer.fit stopped: max_epochs=N reached` after zero training steps.
train.resume_training_checkpoint_path=${prev_best_ckpt}
```

`resume_training_checkpoint_path` is for **interrupted-run resumption** within the same iteration (preserves optimizer state, scheduler, epoch counter — semantics designed for "kill -9 → restart" cases). DEFT iters logically restart the trainer for a new dataset + epoch budget, so they need fresh `pretrained_model_path` init.

Failure mode is silent: `Execution status: PASS` despite no training. Symptom: iter N's train output dir has no new `model_epoch_*.pth`. If you see this, switch the flag.

## Per-Iter Spec `images_dir` — Asymmetric

When deriving `iter${N}_spec.yaml` from `baseline_spec.yaml`, **only `train_dataset.images_dir` moves to the workspace root**; the other dataset blocks keep the kpi-images mount:

| Dataset block | images_dir (container path) | Why |
|---|---|---|
| `train_dataset` | `/data/workspace` | iter combined CSV mixes base rows (`kpi/images/...`) and SDG rows (`results/run_<TS>/iter${N}/dataset/images/...`) — both are workspace-root-relative after assembly |
| `validation_dataset` | `/data/datasets/NV_PCB_Siamese/images` | validation_set.csv carries paths relative to kpi/images/ (the kpi mount root); unchanged from baseline |
| `test_dataset` | `/data/datasets/NV_PCB_Siamese/images` | same — usually points at validation_set.csv |
| `infer_dataset` | `/data/datasets/NV_PCB_Siamese/images` | testing_set.csv carries paths relative to kpi/images/ |

A bulk `sed 's|/data/datasets/NV_PCB_Siamese/images|/data/workspace|g'` on the spec catches all four and breaks the latter three. Edit `train_dataset.images_dir` surgically.

## Two-Checkpoint Compare

Run inference on both the best-val checkpoint (lowest `val_loss`) and the latest checkpoint
(highest epoch). `val_loss` and FAR@100%-recall can diverge — pick the checkpoint with
**lower FAR@100%-recall**, not lower val_loss. See `scripts/analyze_kpi.py` for KPI sweep.

## analyze_kpi.py

```bash
python3 <skill_root>/scripts/analyze_kpi.py \
    <workspace>/results/iter${N}/inference/<label>/inference.csv \
    --output-dir <workspace>/results/iter${N}/inference/<label>
```

Key output line: `100% recall threshold: <T> (FAR=<FAR>%, ...)` — this is the KPI metric.

## Output to deft_state.json

```json
{
  "iterations": {
    "iter${N}": {
      "status": "complete",
      "best_ckpt_path": "<abs_host_path>",
      "best_ckpt_kind": "best_val|latest",
      "far_pct": <float>,
      "threshold": <float>,
      "val_loss": <float>,
      "inference_csv": "<abs_host_path>"
    }
  }
}
```

## ChangeNet backbone resolution

`model.backbone.pretrained_backbone_path` **must point to an existing local file on the host that is bind-mounted into the container.** TAO's `ptm_utils.load_pretrained_weights()` hands the string straight to `torch.load(path, ...)` (with a special-case branch when the suffix is `.safetensors`, calling `safetensors.torch.load_file`). It does **not** dereference `https://`, `hf://`, or HuggingFace repo IDs — passing a URL produces `FileNotFoundError: [Errno 2] No such file or directory: 'https://...'` and `Execution status: FAIL` within ~3 s.

Accepted forms (TAO 7.0.0-rc-224):

| Form | Status |
|---|---|
| Local path to `.pth` / `.ckpt` checkpoint | ✓ works (`torch.load`) |
| Local path to `.safetensors` file | ✓ works (`safetensors.torch.load_file`) |
| `https://huggingface.co/...` URL | ✗ FileNotFoundError |
| HF repo id like `nvidia/C-RADIOv2-B` | ✗ FileNotFoundError |
| `null` or empty | ✗ silently degrades FAR@R=100%; failure mode looks like a training bug |

### Pre-Flight responsibility

Pre-Flight **must stage the backbone locally** before launch. The HuggingFace repo `nvidia/C-RADIOv2-B` ships only `model.safetensors` (no `.pth`), so the canonical recipe is:

```bash
python3 - <<'PY'
from huggingface_hub import hf_hub_download
import shutil, os
src = hf_hub_download(repo_id="nvidia/C-RADIOv2-B", filename="model.safetensors")
dst = "<workspace>/augmentation/backbone/c_radio_v2_b.safetensors"
os.makedirs(os.path.dirname(dst), exist_ok=True)
shutil.copy(src, dst)
PY
```

Then mount as a single file in the train docker invocation:

```bash
-v <workspace>/augmentation/backbone/c_radio_v2_b.safetensors:/data/pretrained_models/C-RADIOv2_B.safetensors
```

And set the spec field to the container-side path:

```yaml
model:
  backbone:
    pretrained_backbone_path: /data/pretrained_models/C-RADIOv2_B.safetensors
```

If `HF_TOKEN` is unset or the workspace already has a staged file, Pre-Flight uses the staged file as-is and skips the download. If neither is available, Pre-Flight **hard stops** — there is no working URL fallback in this TAO version, so silently falling through would just produce the FileNotFoundError above after the container starts.

## Label case rule (CSV assembly)

TAO's ChangeNet classify dataloader does case-sensitive equality against the
literal string `"PASS"` to detect class 0. Lowercasing it puts every row into
class 1 and the `fpratio_sampling` weighted sampler fails immediately at
training start:

```
RuntimeError: invalid multinomial distribution (sum of probabilities <= 0)
RuntimeError: Please call iter(combined_loader) first.
```

Failures reproduce within ~30 s of launching training. The rule: keep `PASS`
exactly as-is; lowercase + strip only the non-`PASS` labels, so `"Missing"`
and `"missing"` collapse to one defect class while `"PASS"` stays the class-0
sentinel.

```python
row["label"] = row["label"] if row["label"] == "PASS" else row["label"].lower().strip()
```

## Log Stage

```bash
python3 <skill_root>/scripts/log_stage.py \
    --log-path results/loop_log.jsonl \
    --iter-label <baseline|iter${N}> \
    --stage train --status ok \
    --summary "FAR=X% threshold=Y val_loss=Z best_ckpt=<kind>"
```
