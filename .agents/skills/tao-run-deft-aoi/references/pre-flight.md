# DEFT Loop Pre-Flight

Resolve everything possible before asking the user. In order:

1. Locate workspace root, specs, CSVs, checkpoints, augmentation assets. Derive a timestamped run directory: `RESULTS_DIR=<workspace>/results/run_$(date +%Y%m%d_%H%M%S)`. If resuming an existing run, set `RESULTS_DIR` to the existing run directory instead (detect by checking for `results/run_*/deft_state.json`). All references to `results/` throughout this workflow mean `${RESULTS_DIR}/`.

   **Host Python deps.** `scripts/analyze_kpi.py` needs `pandas`, `numpy`, `matplotlib`. Verify with `python3 -c "import pandas, numpy, matplotlib"`. If missing, set up a venv (`python3 -m venv ~/.venvs/deft && ~/.venvs/deft/bin/pip install pandas numpy matplotlib`) and invoke via that interpreter — on Ubuntu 24.04+ / fresh Brev boxes a bare `pip3 install --user` hits PEP 668. Alternatively run analysis inside the TAO toolkit image. Do not silently skip — KPI plots are part of every loop's output.
2. Read the relevant `references/*.md` files for command syntax and output contracts. See **Stage Reference Modules** in `references/stage-execution.md` for the stage→skill mapping.
3. Source `<workspace>/.env` if it exists (`set -a; source <workspace>/.env; set +a`). Then verify the credentials the workflow actually consumes:

   | Variable | Required for | Image prefix it gates |
   |---|---|---|
   | `NGC_API_KEY` | All nvcr.io image pulls — TAO toolkit (training, inference, deploy, data services) | `nvcr.io/nvstaging/tao/*` |
   | `HF_TOKEN` | Pre-Flight HuggingFace model downloads (ChangeNet backbone, SigLIP for mining) | huggingface.co |

   Both variables must be non-empty. If either is missing, show the user `.env.example` (next to the skill), ask them to copy it to `<workspace>/.env` and fill in values, and do not proceed until set.

   **Note (EA variant):** `NGC_API_KEY_METROPOLIS_DEV` and the AnomalyGen container are **not** required — this loop ingests pre-generated AnomalyGen output.
4. `docker login nvcr.io` once with `NGC_API_KEY` (username `$oauthtoken`, password = the key). nvcr.io stores one credential per host. Do not fall back to host-side TAO wrappers.
5. **Resolve container image refs from `versions.yaml`.** The rest of this workflow — including the Pre-Flight Summary's `docker image inspect` line, every stage launch, and the `references/*.md` files — references two env vars (this EA variant has no AnomalyGen container, so `AG_IMAGE` is intentionally absent). They are **not** defined elsewhere; resolve them here using `scripts/resolve_versions_key.py` (the single owner of `versions.yaml` schema knowledge) and `export` them so all downstream commands see them:

   ```bash
   SB=${TAO_SKILL_BANK_PATH:-~/tao-skills-external}
   export TAO_PYT_IMAGE=$($SB/scripts/resolve_versions_key.py images.tao_toolkit.pyt)
   export TAO_DS_IMAGE=$($SB/scripts/resolve_versions_key.py  images.tao_toolkit.data_services)
   ```

   | Env var | `versions.yaml` key | Used by |
   |---|---|---|
   | `TAO_PYT_IMAGE` | `images.tao_toolkit.pyt` | `train`, `evaluate`, `rca` (TAO toolkit pyt container) |
   | `TAO_DS_IMAGE` | `images.tao_toolkit.data_services` | `data_mining` (TAO data services container) |

   The script exits non-zero (with a diagnostic on stderr) if a key is missing or empty. Hard stop here — without the export, bash silently substitutes `""`, the next step's `docker image inspect` reports `0` MISSING for every image, and the failure mode points at the wrong root cause.
6. Verify every image resolved in step 5 is present locally (`docker image inspect "$TAO_PYT_IMAGE" "$TAO_DS_IMAGE"`).
7. Apply the path rule: pre-create iter dirs under `${RESULTS_DIR}/iter${ITER}/` and mount `<workspace>` into containers at the same absolute path. Workflows enforce their own container-level invariants (entrypoints, env vars); the loop just supplies the workspace mount and the resolved image URI.
8. **Verify pre-generated AnomalyGen ingestion source.** Confirm `<workspace>/augmentation/anomalygen/reconstructed_image/` and `<workspace>/augmentation/anomalygen/original_image/` both exist and are non-empty. Validate basename pairing: every file under `reconstructed_image/` must have a same-stem partner under `original_image/`. Record the pair count and, if `augmentation/anomalygen/defect_spec.jsonl` is present, the per-defect-type breakdown — both surface in the Pre-Flight Summary. Hard stop on missing dirs, empty dirs, or unpaired files (Invariants §6). Also confirm GPU count. **Stage the ChangeNet C-RADIOv2-B backbone** per `references/visual-changenet.md` → *ChangeNet backbone resolution* — always pre-download to `<workspace>/augmentation/backbone/c_radio_v2_b.pth`, then rewrite `specs/baseline_spec.yaml::model.backbone.pretrained_backbone_path` to the canonical container path. Do not leave an `https://huggingface.co/...` URL in the spec — the TAO container does not auto-pull, it treats the URL as a literal filesystem path.
9. **GPU memory sanity check.** ChangeNet classify with C-RADIOv2-B (ViT-B) at the spec defaults (`batch_size: 64`, `image_width/height: 224`, `cls_weight: [1.0, 10.0]`, learnable difference modules) OOMs on a single 48GB-class GPU. Inspect `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits` and warn if the assembled spec's `dataset.classify.batch_size` is too large for the available memory: as a rule of thumb, **≤ 16 on 48GB GPUs, ≤ 8 on 24GB GPUs**. Surface the recommendation in the Pre-Flight Summary's `GPUs` row — let the user accept or override before launch rather than failing 30 seconds into training.
10. **Stage pre-gen AnomalyGen pairs once via `scripts/prestage_pregen.py`.** The pre-gen NG/OK directories do not change between iterations, only the k-NN target set does — so file staging, `source_pool.{csv,parquet}` assembly, and source-pool SigLIP embedding all hoist here instead of running in every Pipeline iteration. The script writes everything under `${RESULTS_DIR}/synth_pool/` and emits `manifest.json`; per-iter Pipeline step 3 reads that manifest and proceeds directly to k-NN.

    ```bash
    SKILL_ROOT=${TAO_SKILL_BANK_PATH:-~/tao-skills-external}/skills/tao-run-deft-aoi
    python3 $SKILL_ROOT/scripts/prestage_pregen.py \
        --workspace "$WORKSPACE" \
        --results-dir "$RESULTS_DIR" \
        --embed-with-siglip --ds-image "$TAO_DS_IMAGE"
    ```

    The `--embed-with-siglip` flag is strongly recommended: it embeds the source pool (~1000-2000 rows) once per run, and the per-iter mining stage then reuses `source_embeddings.parquet` (cheap re-embedding only of the ~50 weak targets). Without it, each iter re-embeds the full source pool from scratch (~50s wasted per iter).

    Record the manifest path in `deft_state.json[config.pregen]` so the per-iter Pipeline step 3 can read it without re-discovery. **Do not re-stage on resume**: a non-empty `synth_pool/manifest.json` means staging is already done; verify pair counts match and continue.
11. Run train/validation leakage check before resuming any prior run.

Ask one consolidated question only for missing required inputs. Never ask about a parameter with a default.

**Defaults:**

- `max_iterations`: 3 (the loop's value emerges only across multiple iterations; 1 disables convergence detection entirely)
- `training_epochs`: `num_epochs` from `specs/baseline_spec.yaml`, else 20
- `top_k_per_target`: 5 (k-NN survivors per weak target; governs the emergent per-iter synth budget — see **Augmentation Pool** in `references/pipeline.md`)
- `min_similarity` (optional mining cosine cutoff): 0.9 — read from `config.mining_filter.min_similarity` in `deft_state.json`; the literal `0.9` referenced in Pipeline step 4 is just the fallback default.
- workspace root: user prompt, else `~/workspace`
- pretrained backbone: first `*.pth` or `*.ckpt` under `augmentation/backbone/`; if absent, fall through to `https://huggingface.co/nvidia/C-RADIOv2-B` (HF_TOKEN required)

## Pre-Flight Summary

Once all checks pass, print this summary and **STOP — wait for explicit user approval before launching anything**. This is the one user gate in the entire workflow (see **Agent Behavior** in SKILL.md); the loop is autonomous *after* this point, never before.

```
## DEFT Loop — Pre-Flight Summary

### Run config
| Field                          | Value                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ |
| KPI Target                     | FAR < X% at Recall=100%                                                        |
| Max Iterations                 | N                                                                              |
| Training Epochs                | N per iteration                                                                |
| Mining top-K per target        | N (default 5; emergent synth/real per-iter budget = topn × num_weak_targets)   |
| Mining cutoff                  | cosine ≥ <min_similarity> (default 0.9)                                        |
| GPUs                           | N                                                                              |
| Resuming                       | yes — iter N complete / no                                                     |

### Dataset
| Field                          | Value                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Training CSV                   | <path> (N rows)                                                                |
| Validation CSV                 | <path> (N rows)                                                                |
| KPI test CSV                   | <path> (N rows, X defect types)                                                |
| Images dir                     | <path>                                                                         |

### Augmentation
| Field                          | Value                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Pre-gen NG dir                 | <path> (N images)                                                              |
| Pre-gen OK dir                 | <path> (N images, all paired by stem)                                          |
| Defect spec (optional)         | <N types: type1, type2, ...> / not provided                                    |
| SigLIP model                   | <cached / download / local path>                                               |
| Backbone                       | <path> (FOUND / will auto-download from HF ~393 MB)                            |

### Docker Images
Fill the `Image` column with the actual URI resolved in Pre-Flight step 5
(i.e. the value of the env var), not the literal `${VAR}` placeholder.
Print one row per env var so the audit trail shows exactly which tag will run.

| Env var          | Image (resolved from `versions.yaml`)                                          | Status     |
| ---------------- | ------------------------------------------------------------------------------ | ---------- |
| `TAO_PYT_IMAGE`  | `<$TAO_PYT_IMAGE>` (key: `images.tao_toolkit.pyt`)                             | OK/MISSING |
| `TAO_DS_IMAGE`   | `<$TAO_DS_IMAGE>` (key: `images.tao_toolkit.data_services`)                    | OK/MISSING |
```

To populate the summary, run:
```bash
wc -l <training_csv> <validation_csv> <kpi_testing_csv>
python3 -c "import pandas as pd; df=pd.read_csv('<kpi_testing_csv>'); print(df['label'].value_counts().to_string())"
# Pre-gen pair count + basename-pairing check
PG=<workspace>/augmentation/anomalygen
ls "$PG/reconstructed_image/" | wc -l
ls "$PG/original_image/" | wc -l
# Same stems on both sides? (empty diff output = paired)
diff <(ls "$PG/reconstructed_image/" | sed 's/\.[^.]*$//' | sort) \
     <(ls "$PG/original_image/"      | sed 's/\.[^.]*$//' | sort) | head
# Defect spec (optional)
[ -f "$PG/defect_spec.jsonl" ] && python3 -c "import sys,json; [print(json.loads(l)['defect_type']) for l in open('$PG/defect_spec.jsonl')]" || echo "(no defect_spec.jsonl — defect-type breakdown unavailable)"
nvidia-smi --list-gpus | wc -l
# ${TAO_PYT_IMAGE}, ${TAO_DS_IMAGE} are exported by Pre-Flight step 5
# from versions.yaml via scripts/resolve_versions_key.py. Loop per-image so the
# output maps 1:1 to the Docker Images table rows above (you can't fill a
# per-row Status column from a single aggregate "grep -c sha256" count).
for var in TAO_PYT_IMAGE TAO_DS_IMAGE; do
  ref="${!var:?$var unset — re-run Pre-Flight step 5}"
  if docker image inspect "$ref" --format '{{.Id}}' >/dev/null 2>&1; then
    printf '%-14s OK       %s\n' "$var" "$ref"
  else
    printf '%-14s MISSING  %s\n' "$var" "$ref"
  fi
done
```

**Ask the user to confirm before proceeding.** Wait for explicit approval ("looks good", "go", "yes"). Do not start the loop until the user confirms.
