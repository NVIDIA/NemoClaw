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

# HF Hub Push Reference

Pushes the trained checkpoint, model card, and result deliverables to the Hugging
Face Hub. Used in Step 6 of `tao-finetune-huggingface-model`.

---

## Skip rule

If `push_to_hub: false` is explicit in `config.yaml`, skip everything in this
file. Otherwise always push.

## Repo resolution

```python
repo_id = (
    cfg.get("hf_model_repo")                                   # explicit
    or f"{HfApi(token=token).whoami()['name']}/"
       f"{cfg['model_id'].split('/')[-1]}-finetuned"           # auto-derived
)
```

Created **private** by default. Surface the URL to the user.

## Checkpoint resolution

```python
ckpt = "checkpoints/merged" if Path("checkpoints/merged").exists() else "checkpoints/final"
```

Merged exists for VLM LoRA runs. Otherwise the trainer's final checkpoint.

---

## Full push script

```python
import json, yaml, datetime, os
from pathlib import Path
from huggingface_hub import HfApi

cfg = yaml.safe_load(open("config.yaml"))
if cfg.get("push_to_hub") is False:
    print("push_to_hub: false — skipping")
    raise SystemExit(0)

api = HfApi(token=os.environ["HF_TOKEN"])
repo_id = cfg.get("hf_model_repo") or \
    f"{api.whoami()['name']}/{cfg['model_id'].split('/')[-1]}-finetuned"
api.create_repo(repo_id=repo_id, exist_ok=True, private=True)

# Weights
ckpt = "checkpoints/merged" if Path("checkpoints/merged").exists() else "checkpoints/final"
api.upload_folder(folder_path=ckpt, repo_id=repo_id, repo_type="model")

# Model card
eval_m = json.loads(Path("reports/eval_results.json").read_text())
base_m = json.loads(Path("reports/baseline_results.json").read_text()) \
    if Path("reports/baseline_results.json").exists() else {}
primary = {
    "image-classification": "accuracy", "object-detection": "map",
    "semantic-segmentation": "mean_iou", "instance-segmentation": "map",
    "depth-estimation": "abs_rel",
}.get(cfg.get("task"), "accuracy")

card = f"""---
library_name: transformers
base_model: {cfg['model_id']}
datasets: [{cfg.get('dataset_id', 'custom')}]
tags: [{cfg.get('task', 'fine-tuned')}, fine-tuned, nvidia-ngc, tao-finetune-huggingface-model]
---
# {repo_id}

Fine-tuned from [{cfg['model_id']}](https://huggingface.co/{cfg['model_id']})
on `{cfg.get('dataset_id', 'custom dataset')}`. Generated {datetime.date.today()}.

## Results

| Metric | Baseline (zero-shot) | Fine-tuned |
|---|---|---|
| {primary} | {base_m.get(primary, 'N/A')} | {eval_m.get(primary, 'N/A')} |

## Training

- Epochs: {cfg.get('num_train_epochs', cfg.get('n_epochs'))}
- Per-device batch: {cfg.get('per_device_train_batch_size')}
- Learning rate: {cfg.get('learning_rate')}
- Precision: {"bf16" if cfg.get('bf16') else "fp32"}
- NGC image: `{cfg.get('ngc_image', 'N/A')}`

## Usage

```python
from transformers import pipeline
pipe = pipeline("{cfg.get('task', 'image-classification')}", model="{repo_id}")
```
"""
Path("README.md").write_text(card)
api.upload_file(path_or_fileobj="README.md", path_in_repo="README.md",
                repo_id=repo_id, repo_type="model")

# Deliverables under results/
for local in [
    "reports/eval_results.json", "reports/baseline_results.json",
    "config.yaml", "Dockerfile", "requirements.txt",
]:
    if Path(local).exists():
        api.upload_file(path_or_fileobj=local,
                        path_in_repo=f"results/{Path(local).name}",
                        repo_id=repo_id, repo_type="model")

# Sample predictions
for img in sorted(Path("reports/inference_samples").glob("*.jpg"))[:5]:
    api.upload_file(path_or_fileobj=str(img),
                    path_in_repo=f"results/inference_samples/{img.name}",
                    repo_id=repo_id, repo_type="model")

# Optional report (if emit_report: true)
for f in ["reports/report.pdf", "reports/report.html"]:
    if Path(f).exists():
        api.upload_file(path_or_fileobj=f,
                        path_in_repo=f"results/{Path(f).name}",
                        repo_id=repo_id, repo_type="model")

print(f"Pushed: https://huggingface.co/{repo_id}")
```

---

## What ends up in the repo

| Path | Source |
|---|---|
| `config.json`, `model.safetensors`, etc. | `checkpoints/final` (or `merged`) |
| `README.md` | model card written above |
| `results/eval_results.json` | post-train eval |
| `results/baseline_results.json` | zero-shot baseline (if not skipped) |
| `results/config.yaml` | training config snapshot |
| `results/requirements.txt` | dependency snapshot |
| `results/Dockerfile` | container snapshot |
| `results/inference_samples/*.jpg` | first 5 inference samples |
| `results/report.{pdf,html}` | only if `emit_report: true` |
