# DINO Error Patterns and Troubleshooting

**CUDA out of memory**: Reduce dataset.batch_size (4 -> 2 -> 1). DINO uses multi-scale features that consume significant GPU memory, especially with high-resolution images (default max 1333px).

**num_select must be < num_queries * num_classes**: Ensure model.num_select (default 300) is less than num_queries * dataset.num_classes.

**Error merging spec.yaml with schema**: Hydra/OmegaConf validation error. num_epochs and num_gpus must be under 'train.*', not at spec root. Use the SDK spec_shorthand_keys mapping.

**Dataset size smaller than total batch size**: Total batch = batch_size * num_gpus. If val dataset has fewer samples, reduce dataset.batch_size or num_gpus. The agent should proactively check this.

**return_interm_indices length must match num_feature_levels**: Default is [1,2,3,4] with num_feature_levels=4. If changing one, update the other.

**`FileNotFoundError` on images**: The archive extraction/cache and annotation paths are out of sync. For standard DINO datasets, pass remote `images.tar.gz`; the SDK should rewrite the runtime spec to `images`. If DINO looks under `/mnt/lustre/.../images/<file>.jpg` and files are missing, clear the stale `<images.tar.gz>.extracted` marker and re-extract/download the archive, or inspect the archive top-level layout.

**`FileNotFoundError` at startup (val)**: `val_data_sources` missing or pointing to non-existent data. DINO unconditionally builds a val dataloader — this is required even when only optimizing `train_loss`.

**`CUDA device-side assert`**: `num_classes` too low. Set `num_classes >= max(category_id) + 1`.

**S3 inputs not downloaded inside container**: When the agent invokes DINO via SDK orchestration, `skill_info.yaml` must declare `actions.train.inputs` with `[0]`-indexed spec keys (see `sdk_orchestration.md`). Use `s3://...` for S3-compatible datasets; do not generate `aws://...` URIs.

**Evaluate checkpoint not found at result root**: DINO train jobs upload
checkpoints under `results_dir/train/`. If eval fails with `FileNotFoundError`
for `s3://<bucket>/results/<train_job_id>/dino_model_latest.pth`, set
`evaluate.checkpoint` to
`s3://<bucket>/results/<train_job_id>/results_dir/train/dino_model_latest.pth`.
