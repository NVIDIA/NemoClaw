<!--
Copyright (c) 2026, NVIDIA CORPORATION.  All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Error Playbook — tao-finetune-huggingface-model

When you hit an error, consult this table before redesigning anything. Apply
the minimal fix that keeps the user's original request intact.

The compat-workarounds registry at `compat-workarounds.md` (sibling reference)
is the durable form of this table — entries there are auto-detected at Step
1d, before the error has a chance to fire. **When the same row in this table
fires twice across runs, lift it into `compat-workarounds.md` with a `detect`
rule.** Tell the user when you do.

---

| Symptom | Fix |
|---|---|
| `DataLoader worker ... Bus error` | Add `--shm-size=16g` to `docker run`. |
| Container starts then hangs | NGC ENTRYPOINT. Use `--rm` for one-shots; `ENTRYPOINT ["/bin/bash","-c"]` in Dockerfile. |
| `ImportError: cannot import name 'main' from 'evaluate'` | Script named `evaluate.py`. Rename to `run_eval.py` — HF `evaluate` lib shadows it. |
| `pip cache purge` fails in build | NGC disables pip cache. Remove the line. |
| `TypeError: ... enable_gqa` at step 0 | PyTorch 2.5.0 SDPA+GQA bug (NGC 24.09). Set `attn_implementation: "eager"`. |
| `TypeError: Missing **kwargs in ... @check_model_inputs` (Idefics3 / Llava / Mllama) | `transformers>=4.51` regression. Pin `transformers==4.49.0 tokenizers==0.21.0`. |
| `trl>=1.0` breaking API on import | Pin `trl>=0.18.0,<1.0.0`. |
| `ValueError: ... CVE-2025-32434` torch.load | NGC 25.01 PyTorch 2.6.0a + `transformers>=4.51` refuses `.bin` checkpoints. If model ships only `pytorch_model.bin`, pin `transformers==4.49.0 tokenizers==0.21.0`. Safetensors models unaffected. |
| `ImportError: numpy.core.multiarray failed to import` | numpy 2.x ABI break. Pin `numpy<2`. |
| Albumentations `y_max <= y_min for bbox` | Degenerate bboxes. Add `filter_invalid_bboxes=True`, `min_area=1` to `A.BboxParams`. |
| Detection: `'list' object has no attribute 'logits'` in `compute_metrics` | Trainer with `eval_do_concat_batches=False`. Drop in-trainer metric, use `metric_for_best_model=eval_loss`, run mAP via `run_eval.py` post-training. |
| PEFT + `gradient_checkpointing`: `element 0 ... does not require grad` | After `get_peft_model(...)`, call `model.enable_input_require_grads()`. |
| Idefics3/SmolVLM: vision tower SDPA error | Set `_attn_implementation="eager"` on every model load. Store in `config.yaml: attn_implementation:`. |
| Model barely learns, loss ≈ random | Don't set `torch_dtype=torch.bfloat16`. Load fp32, set `bf16=True` in `TrainingArguments`. |
| Labels saved as `LABEL_0/1` not class names | Pass `id2label=` from `ClassLabel.names` to `from_pretrained`. |
| Arrow drops `PIL.Image` after `load_from_disk` | `ds.cast_column("image", datasets.Image())`. |
| LoRA reports 5-10% trainable (expected 0.1-1%) | Target regex too broad. VLMs: `target_modules=".*language_model.*"`. |
| UCX segfault on container exit | Harmless NCCL cleanup. Check `checkpoints/final/` exists. |
| Step 0 hangs for minutes | Streaming dataset. Run `prepare_data.py` first. |
| CV: ~57% accuracy where SOTA is 94%+ | Missing augmentation. Add `RandomResizedCrop` + `RandomHorizontalFlip`. |
| OOM at step 0 | Halve `per_device_train_batch_size`, double `gradient_accumulation_steps`, enable `gradient_checkpointing`. |
