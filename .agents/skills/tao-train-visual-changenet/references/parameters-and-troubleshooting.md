# Visual ChangeNet Parameters, Hardware, and Troubleshooting

## Important Parameters

- **train.validation_interval**: Default 50. Run validation every N epochs. **IMPORTANT: must be ≤ num_epochs**, otherwise no validation runs and training may fail or produce no metrics. For short runs (e.g., 10 epochs), set to 5.
- **train.checkpoint_interval**: Default 200. Save checkpoint every N epochs. **IMPORTANT: must be ≤ num_epochs**, otherwise no checkpoint is saved and the training output is lost. For short runs, set to match num_epochs or lower.
- **train.num_epochs**: Default 100. Defect detection datasets are typically small, so training may converge in 50-100 epochs. Monitor validation metrics to avoid overfitting.
- **model.classify.train_margin_euclid**: Margin for the Euclidean distance loss during training (default 2.0). Larger values push embeddings further apart. Increase if the model struggles to separate defective from non-defective.
- **model.classify.eval_margin**: Classification threshold during evaluation (default 0.3). Samples with embedding distance below this margin are classified as non-defective; above as defective. This is the primary knob for precision/recall tradeoff -- lower values increase recall (catch more defects), higher values increase precision (fewer false alarms).
- **model.classify.embedding_vectors**: Number of embedding dimensions (default 5). Increase for more complex defect patterns; decrease for simpler binary tasks.
- **dataset.classify.batch_size**: Default 16. Can be increased for small images (224x224) on GPUs with sufficient VRAM.
- **dataset.classify.fpratio_sampling**: False positive ratio for balanced sampling during training (default 0.25). Controls the ratio of non-defective to defective samples in each batch.
- **train.classify.cls_weight**: Class weights for cross-entropy loss (default [1.0, 10.0]). The higher weight on class 1 (defective) compensates for class imbalance typical in defect detection datasets.

## Hardware

- **Minimum**: 1 GPU with 16GB+ VRAM (V100 or A100). Single-GPU training works for small datasets (<10k images).
- **Recommended**: 8 GPUs for production training on larger datasets. Visual ChangeNet uses DDP (DistributedDataParallel) across GPUs.
- GPU count is managed internally by TAO -- do not set `gpu_spec_key` in the spec. The `num_nodes` field (default 1) controls multi-node training.

## Error Patterns

**Checkpoint not found**: The evaluate and inference actions require a valid checkpoint path. If training output was moved or the results_dir changed, update `evaluate.checkpoint` or `inference.checkpoint` to the correct path. The default template `${results_dir}/train/changenet_model_classify_latest.pth` resolves at runtime -- ensure results_dir is set correctly.

**CSV format mismatch**: The CSV must have exactly three columns: `input_path`, `object_name`, `label`. Missing columns or extra headers cause a silent failure or KeyError. Verify the CSV has no BOM characters and uses comma delimiters (not semicolons or tabs).

**Image extension mismatch**: If `dataset.classify.image_ext` is `.jpg` but the actual images are `.png` (or vice versa), the data loader will find zero samples and training will fail with an empty dataset error. Always verify the extension matches your data.

**OOM during training**: Reduce `dataset.classify.batch_size` (16 -> 8 -> 4). With the default image size of 224x224, batch_size=16 typically fits on a 16GB GPU. If using larger images via `image_width`/`image_height`, reduce batch size proportionally.

**Low evaluation accuracy with correct training loss**: The `eval_margin` threshold may be miscalibrated for your data. After training, run inference on a validation set and inspect the embedding distance distribution to pick an appropriate threshold. The default 0.3 is tuned for the reference dataset and may not generalize.

**`AssertionError: Contrastive loss only supports Euclidean distance module`** at evaluate/inference: the spec dropped the `train` subtree. Model `__init__` reads `train.classify.loss` regardless of action; omitting it falls back to contrastive loss, which then conflicts with non-default `model.classify.difference_module` (e.g. `learnable`) saved in the checkpoint. Keep `train.classify.loss` (and `train.classify.cls_weight`) in the spec for evaluate and inference too.

**Training does not converge**: Check that `train.classify.cls_weight` is appropriate for your class distribution. If defects are very rare (<1% of samples), increase the defective class weight. Also verify that `fpratio_sampling` is not too low, which would under-sample the majority class.

**OSError: Could not load MultiScaleDeformableAttention...so** (segment only): CUDA ops not compiled. The ViT adapter backbone requires custom CUDA kernels that must be compiled on first run. Run `python setup.py develop` inside the container (~5 min compilation). This only applies to the segmentation task.

**MisconfigurationException: current_epoch=N, but max_epochs=M**: Old checkpoints in results directory. PyTorch Lightning auto-resumes from checkpoints and crashes if the new `max_epochs` is lower than a previous run's epoch. Fix: use a fresh results directory or unique run name.

**PYTHONPATH / ModuleNotFoundError: nvidia_tao_pytorch**: The TAO entrypoint spawns subprocesses that don't source `.bashrc`. Pass `PYTHONPATH` explicitly via environment variables, not shell init files. The TAO pyt container resolved from `versions.yaml::images.tao_toolkit.pyt` has PYTHONPATH pre-configured.

**Epoch defaults**: Classify training typically uses 100-2000 epochs depending on dataset size. Segmentation uses 200 epochs by default. For small datasets (<1k images), 100 epochs may suffice. For large production datasets, 2000 epochs with early stopping is common. Monitor validation metrics to determine convergence.
