# Prepare-for-Inference

Final step of the DEFT loop. Produces two artifacts under `${RESULTS_DIR}/` so
downstream inference skills can consume the trained checkpoint without reading
`deft_state.json` or the training spec.

## Artifacts

| File | Role |
|---|---|
| `best_model.json` | 6-field handoff metadata. The contract every consumer reads. |
| `best_model_inference_spec.yaml` | Ready-to-run TAO inference spec. The executable artifact. |

Both are written by `scripts/prepare_inference_spec.py`. Never hand-edit either
file — keeping them in sync is the script's job.

### `best_model.json`

```json
{
  "checkpoint":     "/abs/path/to/best.pth",
  "threshold":      0.237481,
  "far_pct":        43.747,
  "iteration":      "iter1",
  "backbone":       "/abs/path/to/c_radio_v2_b.ckpt",
  "images_dir":     "/abs/path/to/kpi/images",
  "training_spec":  "/abs/path/to/baseline_spec.yaml"
}
```

| Field | Meaning |
|---|---|
| `checkpoint` | Best `.pth` (the iteration with lowest `far_pct`, including baseline) |
| `threshold` | Decision threshold at recall=100% — **always use this, never the spec default** |
| `far_pct` | FAR achieved at that threshold. Surface to operators alongside scores. |
| `iteration` | Which iteration won (`baseline`, `iter1`, …) |
| `backbone` | Absolute path to the backbone `.ckpt` (mount this into the container) |
| `images_dir` | Path the model was evaluated against. Useful default for re-running on KPI data. |
| `training_spec` | Path to the training YAML used. Read this if you need fields the JSON doesn't expose. |

### `best_model_inference_spec.yaml`

Built by copying `model.*` and `dataset.classify.*` verbatim from the training
spec, then:

- Stripping `train_dataset`, `validation_dataset`, `test_dataset` from `dataset.classify`
- Setting `dataset.classify.infer_dataset.{csv_path,images_dir}` to empty (CONSUMER fills in)
- Setting `inference.checkpoint` to the best checkpoint
- Setting `model.classify.eval_margin` to the KPI threshold (overrides default 0.3)
- Disabling augmentation (`augmentation_config.augment: false`)
- Adding a stub `train.classify.loss` (TAO's `load_from_checkpoint` rebuilds the criterion and asserts on the loss/difference_module pairing)

The consumer sets four things and runs:

1. `dataset.classify.infer_dataset.csv_path` — their inference CSV
2. `dataset.classify.infer_dataset.images_dir` — their images root
3. `inference.results_dir` — where outputs go
4. `results_dir` — top-level results dir (TAO requires it)

## Consumer Workflow

```bash
# 1. Read handoff metadata
jq . ${RESULTS_DIR}/best_model.json

# 2. Edit the spec to point at your data (or override on CLI)
cp ${RESULTS_DIR}/best_model_inference_spec.yaml /tmp/my_inference.yaml
# … set the four CONSUMER fields …

# 3. Resolve the TAO pyt image URI from versions.yaml (single source of truth).
TAO_PYT_IMAGE=$("${TAO_SKILL_BANK_PATH:?}/scripts/resolve_versions_key.py" images.tao_toolkit.pyt)

# 4. Run inference. Mount paths from best_model.json into the container.
docker run --rm --gpus all --shm-size=8g \
    --user "$(id -u):$(id -g)" \
    -v <your_csv_dir>:/data/infer \
    -v $(jq -r .images_dir ${RESULTS_DIR}/best_model.json):/data/images \
    -v $(jq -r .checkpoint ${RESULTS_DIR}/best_model.json):/model/best.pth \
    -v $(jq -r .backbone ${RESULTS_DIR}/best_model.json):/data/pretrained_models/C-RADIOv2_B.pth \
    -v /tmp/my_inference.yaml:/specs/inference.yaml \
    -v <output_dir>:/results \
    "$TAO_PYT_IMAGE" \
    visual_changenet inference -e /specs/inference.yaml
```

The `--shm-size=8g` is required — TAO dataloaders crash with bus errors on the
default 64MB allocation.

## Threshold Contract

Use `threshold` from `best_model.json`, not the `eval_margin` default in the
spec. The default is calibrated for a reference dataset and **does not generalize**.

The KPI threshold was chosen at recall=100% on the KPI test set — it is the
operating point that catches every defect at the cost of the reported `far_pct`.
A consumer that ignores it will see arbitrary results.

The script sets `model.classify.eval_margin` in the generated YAML to the
KPI-derived value, so consumers who run the YAML as-is get the right
threshold automatically.

## Silent-Failure Modes (Avoid These)

These are the four ways a config-mismatched inference run can produce
misleading or no output. The script prevents all of them by copying training
config verbatim, but if you build an inference spec by hand, watch out:

1. **`concat_type` mismatch (silent).** Training used `grid` 2×2, inference set
   to `linear`. Loads cleanly, produces wrong scores. Always copy `concat_type`
   and `grid_map` from the training spec.

2. **`difference_module` mismatch (cryptic).** Training used `euclidean`,
   inference set to `learnable`. Fails with `KeyError:
   model.backbone.radio.radio.radio.model.patch_generator.pos_embed` deep
   inside `load_state_dict`. The two architectures have different key
   nesting depths.

3. **`image_ext` mismatch (empty dataset).** Training used `.jpg`, inference
   set to `.png`. Dataloader finds zero rows; predict loop runs over 0 batches;
   no error. Verify `image_ext` matches actual files on disk.

4. **`loss` / `difference_module` pair (assertion).** Contrastive loss requires
   `difference_module: euclidean`. CE loss works with either. The training spec
   already paired them correctly — copy both fields together, never one without
   the other.

## When to Re-Run

Re-run `prepare_inference_spec.py` whenever:

- The loop finishes (handled automatically as the final step).
- A new iteration completes and you want to evaluate against the latest best.
  The script always picks lowest `far_pct` from `deft_state.json` — so calling
  it mid-loop gives you the current best, not necessarily the final best.

Do **not** re-run after manually editing `deft_state.json`. Disk is canonical;
if state is stale, the artifact is wrong.
