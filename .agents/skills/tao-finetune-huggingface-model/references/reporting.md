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

# Report Generation Reference

Used in Phase 10 of tao-finetune-huggingface-model skill.
Generates report.pdf and report.html with training curves, eval metrics (including baseline
vs post-training delta), sample predictions, and a summary table.

**Data source:** HF Trainer writes a canonical `trainer_state.json` into the output directory
(e.g., `checkpoints/checkpoint-N/trainer_state.json` and the final `checkpoints/final/trainer_state.json`).
This file contains all logged metrics as structured JSON — far more reliable than regex-parsing
the text log.

---

## report.py — Full Template

```python
"""
report.py — Generate PDF + HTML training report with charts.

Usage:
  python report.py --config config.yaml \
                   --eval_results reports/eval_results.json \
                   --inference_samples reports/inference_samples/ \
                   --log_file logs/train.log \
                   --output reports/
"""
import argparse
import json
import os
import re
import yaml
from datetime import datetime
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
from matplotlib.backends.backend_pdf import PdfPages
import numpy as np
from PIL import Image as PILImage


# ── Arg parsing ──────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--eval_results", default="reports/eval_results.json")
    p.add_argument("--baseline_results", default="reports/baseline_results.json")
    p.add_argument("--inference_samples", default="reports/inference_samples")
    p.add_argument("--trainer_state", default="checkpoints/final/trainer_state.json",
                   help="Path to HF Trainer's trainer_state.json")
    p.add_argument("--output", default="reports/")
    return p.parse_args()


# ── Training metrics parsing (trainer_state.json — canonical) ───────────────

def parse_trainer_state(trainer_state_path: str):
    """Load HF Trainer's canonical log_history from trainer_state.json.

    log_history is a list of dicts like:
      {"loss": 0.42, "learning_rate": 1e-5, "epoch": 0.5, "step": 50}
      {"eval_loss": 0.38, "eval_accuracy": 0.71, "epoch": 1.0, "step": 100}
    """
    steps, losses, lrs = [], [], []
    eval_steps, eval_losses, eval_metrics = [], [], []   # eval_metrics: {metric_name: [values]}

    if not os.path.exists(trainer_state_path):
        # Fallback — search for trainer_state.json in checkpoint subdirs
        parent = Path(trainer_state_path).parent.parent
        candidates = sorted(parent.glob("checkpoint-*/trainer_state.json"))
        if candidates:
            trainer_state_path = str(candidates[-1])        # most recent checkpoint
        else:
            print(f"WARN: no trainer_state.json at {trainer_state_path}; charts will be empty")
            return steps, losses, lrs, eval_steps, eval_losses, {}

    with open(trainer_state_path) as f:
        state = json.load(f)

    eval_series = {}
    for entry in state.get("log_history", []):
        step = entry.get("step")
        if "loss" in entry and step is not None:
            steps.append(step)
            losses.append(entry["loss"])
            lrs.append(entry.get("learning_rate", 0))
        if "eval_loss" in entry and step is not None:
            eval_steps.append(step)
            eval_losses.append(entry["eval_loss"])
            # Capture all eval_* metrics
            for k, v in entry.items():
                if k.startswith("eval_") and k != "eval_loss" and isinstance(v, (int, float)):
                    eval_series.setdefault(k, []).append((step, v))

    return steps, losses, lrs, eval_steps, eval_losses, eval_series


# ── Chart helpers ─────────────────────────────────────────────────────────────

def fig_loss_curve(steps, losses, eval_steps, eval_losses, title="Training Loss"):
    fig, ax = plt.subplots(figsize=(10, 4))
    if steps:
        ax.plot(steps, losses, label="Train loss", color="#76b900", linewidth=1.5, alpha=0.8)
    if eval_steps:
        ax.plot(eval_steps, eval_losses, label="Eval loss", color="#ff6b35",
                linewidth=2, marker="o", markersize=5)
    ax.set_xlabel("Step")
    ax.set_ylabel("Loss")
    ax.set_title(title)
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    return fig


def fig_lr_schedule(steps, lrs):
    fig, ax = plt.subplots(figsize=(10, 3))
    if steps:
        ax.plot(steps, lrs, color="#1f77b4", linewidth=1.5)
    ax.set_xlabel("Step")
    ax.set_ylabel("Learning Rate")
    ax.set_title("Learning Rate Schedule")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    return fig


def fig_metrics_bar(eval_results: dict, task: str):
    metrics = {k: v for k, v in eval_results.items()
               if isinstance(v, float) and k not in ("n_eval",)}
    if not metrics:
        return None

    fig, ax = plt.subplots(figsize=(8, 4))
    keys = list(metrics.keys())
    vals = [metrics[k] * 100 if metrics[k] <= 1.0 else metrics[k] for k in keys]
    colors = ["#76b900" if v >= 60 else "#ff6b35" if v >= 40 else "#cc0000" for v in vals]
    bars = ax.barh(keys, vals, color=colors)
    ax.bar_label(bars, fmt="%.2f%%", padding=4, fontsize=10)
    ax.set_xlabel("Score (%)")
    ax.set_title(f"Evaluation Metrics — {task}")
    ax.set_xlim(0, max(vals) * 1.2)
    ax.grid(True, alpha=0.3, axis="x")
    fig.tight_layout()
    return fig


def fig_inference_samples(samples_dir: str, n: int = 5, task: str = "image-classification"):
    """Create a grid of inference samples."""
    samples_path = Path(samples_dir)
    input_imgs = sorted(samples_path.glob("sample_*_input.jpg"))[:n]
    pred_imgs = sorted(samples_path.glob("sample_*_pred.jpg"))[:n]
    metas = sorted(samples_path.glob("sample_*_meta.json"))[:n]

    if not input_imgs:
        return None

    n_cols = min(n, len(input_imgs))
    has_pred = len(pred_imgs) > 0
    n_rows = 2 if has_pred else 1

    fig, axes = plt.subplots(n_rows, n_cols, figsize=(4 * n_cols, 4 * n_rows))
    if n_rows == 1 and n_cols == 1:
        axes = np.array([[axes]])
    elif n_rows == 1:
        axes = axes.reshape(1, -1)
    elif n_cols == 1:
        axes = axes.reshape(-1, 1)

    for j, img_path in enumerate(input_imgs):
        img = PILImage.open(img_path).convert("RGB")
        axes[0, j].imshow(img)
        axes[0, j].axis("off")

        title = f"Sample {j}"
        if metas and j < len(metas):
            try:
                meta = json.loads(metas[j].read_text())
                if task == "image-classification":
                    pred = meta.get("top_predictions", [{}])[0]
                    title = f"{pred.get('label','?')} ({pred.get('score',0):.2f})"
                elif task == "image-text-to-text":
                    title = meta.get("predicted", "")[:40]
            except Exception:
                pass
        axes[0, j].set_title(title, fontsize=8, wrap=True)

    if has_pred:
        for j, img_path in enumerate(pred_imgs):
            img = PILImage.open(img_path).convert("RGB")
            axes[1, j].imshow(img)
            axes[1, j].axis("off")
            axes[1, j].set_title("Prediction", fontsize=8)

    plt.suptitle("Inference Samples", fontsize=12, fontweight="bold")
    fig.tight_layout()
    return fig


def fig_config_table(cfg: dict):
    """Render key config values as a matplotlib table."""
    keys_to_show = [
        "model_id", "task", "training_method", "num_train_epochs",
        "per_device_train_batch_size", "learning_rate", "lr_scheduler_type",
        "bf16", "use_lora", "lora_r", "max_seq_length", "n_train", "n_eval",
    ]
    rows = [[k, str(cfg.get(k, "N/A"))] for k in keys_to_show if k in cfg]

    fig, ax = plt.subplots(figsize=(8, max(3, len(rows) * 0.35 + 1)))
    ax.axis("off")
    tbl = ax.table(
        cellText=rows,
        colLabels=["Parameter", "Value"],
        loc="center",
        cellLoc="left",
    )
    tbl.auto_set_font_size(False)
    tbl.set_fontsize(9)
    tbl.scale(1, 1.4)
    # Header styling
    for (row, col), cell in tbl.get_celld().items():
        if row == 0:
            cell.set_facecolor("#76b900")
            cell.set_text_props(color="white", fontweight="bold")
        elif row % 2 == 0:
            cell.set_facecolor("#f5f5f5")
    ax.set_title("Training Configuration", fontsize=11, fontweight="bold", pad=12)
    fig.tight_layout()
    return fig


# ── HTML report ───────────────────────────────────────────────────────────────

def write_html(output_dir: str, cfg: dict, eval_results: dict, chart_paths: list, date_str: str):
    model_id = cfg.get("model_id", "unknown")
    task = cfg.get("task", "unknown")
    method = cfg.get("training_method", "sft")

    metric_rows = "".join(
        f"<tr><td>{k}</td><td><b>{v:.4f}</b> ({v*100:.2f}%)</td></tr>"
        if isinstance(v, float) and v <= 1.0
        else f"<tr><td>{k}</td><td><b>{v}</b></td></tr>"
        for k, v in eval_results.items() if k != "n_eval"
    )

    charts_html = "".join(
        f'<div class="chart"><img src="{Path(p).name}" style="max-width:100%;"></div>'
        for p in chart_paths if p and os.path.exists(p)
    )

    html = f"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Training Report — {model_id}</title>
<style>
  body {{ font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }}
  h1 {{ color: #76b900; }} h2 {{ color: #333; border-bottom: 2px solid #76b900; padding-bottom: 5px; }}
  table {{ border-collapse: collapse; width: 100%; margin: 10px 0; }}
  th {{ background: #76b900; color: white; padding: 8px; text-align: left; }}
  td {{ padding: 8px; border: 1px solid #ddd; }}
  tr:nth-child(even) {{ background: #f9f9f9; }}
  .chart {{ margin: 20px 0; text-align: center; }}
  .meta {{ background: #f0f7e6; padding: 15px; border-radius: 5px; margin: 10px 0; }}
</style>
</head><body>
<h1>Training Report</h1>
<div class="meta">
  <b>Model:</b> {model_id} &nbsp;|&nbsp;
  <b>Task:</b> {task} &nbsp;|&nbsp;
  <b>Method:</b> {method} &nbsp;|&nbsp;
  <b>Date:</b> {date_str} &nbsp;|&nbsp;
  <b>N eval:</b> {eval_results.get("n_eval", "N/A")}
</div>

<h2>Evaluation Results</h2>
<table><tr><th>Metric</th><th>Value</th></tr>{metric_rows}</table>

<h2>Charts</h2>
{charts_html}

<footer><p style="color:#999;font-size:12px;">Generated by tao-finetune-huggingface-model skill — {date_str}</p></footer>
</body></html>"""

    html_path = Path(output_dir) / "report.html"
    html_path.write_text(html)
    print(f"HTML report: {html_path}")


# ── Main ──────────────────────────────────────────────────────────────────────

def fig_baseline_vs_finetuned(baseline: dict, finetuned: dict, task: str):
    """Grouped bar chart comparing pre- vs post-training metrics."""
    common = [k for k in finetuned if k in baseline
              and isinstance(finetuned[k], (int, float))
              and isinstance(baseline[k], (int, float))
              and k != "n_eval"]
    if not common:
        return None

    fig, ax = plt.subplots(figsize=(10, 4.5))
    x = np.arange(len(common))
    width = 0.35

    baseline_vals = [baseline[k] * 100 if baseline[k] <= 1.0 else baseline[k] for k in common]
    finetuned_vals = [finetuned[k] * 100 if finetuned[k] <= 1.0 else finetuned[k] for k in common]

    b1 = ax.bar(x - width/2, baseline_vals, width, label="Zero-shot baseline", color="#888")
    b2 = ax.bar(x + width/2, finetuned_vals, width, label="Fine-tuned", color="#76b900")
    ax.bar_label(b1, fmt="%.1f", padding=3, fontsize=8)
    ax.bar_label(b2, fmt="%.1f", padding=3, fontsize=8)

    ax.set_xticks(x)
    ax.set_xticklabels(common, rotation=15, ha="right")
    ax.set_ylabel("Score")
    ax.set_title(f"Baseline vs Fine-tuned — {task}")
    ax.legend()
    ax.grid(True, alpha=0.3, axis="y")
    fig.tight_layout()
    return fig


def main():
    args = parse_args()
    with open(args.config) as f:
        cfg = yaml.safe_load(f)

    with open(args.eval_results) as f:
        eval_results = json.load(f)

    # Load baseline if available
    baseline_results = None
    if os.path.exists(args.baseline_results):
        with open(args.baseline_results) as f:
            baseline_results = json.load(f)

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    date_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    steps, losses, lrs, eval_steps, eval_losses, eval_series = parse_trainer_state(args.trainer_state)
    task = cfg.get("task", "unknown")

    # Save charts as PNGs (for HTML embedding)
    chart_paths = []

    def save_fig(fig, name):
        if fig is None:
            return None
        path = str(out_dir / name)
        fig.savefig(path, dpi=150, bbox_inches="tight")
        plt.close(fig)
        chart_paths.append(path)
        return path

    save_fig(fig_config_table(cfg), "chart_config.png")
    save_fig(fig_loss_curve(steps, losses, eval_steps, eval_losses,
                            title=f"Loss — {cfg.get('model_id','')}"), "chart_loss.png")
    save_fig(fig_lr_schedule(steps, lrs), "chart_lr.png")
    save_fig(fig_metrics_bar(eval_results, task), "chart_metrics.png")
    if baseline_results:
        save_fig(fig_baseline_vs_finetuned(baseline_results, eval_results, task),
                 "chart_baseline_vs_finetuned.png")
    save_fig(fig_inference_samples(args.inference_samples, n=5, task=task), "chart_samples.png")

    # PDF
    pdf_path = out_dir / "report.pdf"
    with PdfPages(str(pdf_path)) as pdf:
        # Cover page
        fig_cover, ax = plt.subplots(figsize=(11, 8.5))
        ax.axis("off")
        ax.text(0.5, 0.7, "Training Report", ha="center", fontsize=28, fontweight="bold",
                color="#76b900", transform=ax.transAxes)
        ax.text(0.5, 0.58, cfg.get("model_id", "unknown"), ha="center", fontsize=18,
                color="#333", transform=ax.transAxes)
        ax.text(0.5, 0.48, f"Task: {task}  |  Method: {cfg.get('training_method','sft')}",
                ha="center", fontsize=14, color="#555", transform=ax.transAxes)
        ax.text(0.5, 0.38, f"Dataset: {cfg.get('dataset_id','')}  |  n_train={cfg.get('n_train','')}",
                ha="center", fontsize=12, color="#777", transform=ax.transAxes)
        ax.text(0.5, 0.28, date_str, ha="center", fontsize=11, color="#999", transform=ax.transAxes)
        pdf.savefig(fig_cover)
        plt.close(fig_cover)

        for path in chart_paths:
            if path and os.path.exists(path):
                fig, ax = plt.subplots(figsize=(11, 7))
                img = PILImage.open(path)
                ax.imshow(img)
                ax.axis("off")
                pdf.savefig(fig, bbox_inches="tight")
                plt.close(fig)

    print(f"PDF report: {pdf_path}")

    write_html(str(out_dir), cfg, eval_results, chart_paths, date_str)
    print(f"\nReport complete. Assets in {out_dir}/")


if __name__ == "__main__":
    main()
```

---

## Install Requirements for Report

The report.py requires matplotlib, seaborn, Pillow. These are in `requirements.txt`.
If running report outside the training container (e.g. on the host):

```bash
pip install matplotlib seaborn pillow pyyaml
```

Or run inside the training container:
```bash
docker run --rm \
  -v $(pwd)/output_dir:/workspace \
  $NGC_IMAGE \
  "cd /workspace && python report.py --config config.yaml \
     --eval_results reports/eval_results.json \
     --inference_samples reports/inference_samples/ \
     --log_file logs/train.log \
     --output reports/"
```

---

## Expected Report Structure

```
reports/
├── report.pdf              ← Multi-page PDF with all charts
├── report.html             ← Standalone HTML (embeds PNG charts)
├── chart_config.png        ← Training config table
├── chart_loss.png          ← Train + eval loss curve
├── chart_lr.png            ← Learning rate schedule
├── chart_metrics.png       ← Eval metrics bar chart
├── chart_samples.png       ← Inference sample grid
├── eval_results.json       ← Raw metrics (from Phase 8)
└── inference_samples/      ← Per-sample images + meta.json (from Phase 9)
```

---

## wandb Artifacts Integration

If wandb tracking was used, supplement the report with wandb run URL:

```python
import wandb

# In report.py, after writing PDF:
run_name = os.environ.get("WANDB_RUN_NAME")
project = os.environ.get("WANDB_PROJECT")
entity = os.environ.get("WANDB_ENTITY", "your-entity")
if run_name and project:
    print(f"\nwandb run: https://wandb.ai/{entity}/{project}/runs/{run_name}")
    print("Charts and metrics are also available in the wandb dashboard.")
```

Add the wandb URL to the HTML report cover section.

---

## Report Gotcha: Log parsing depends on HF Trainer format

HF Trainer logs metrics as JSON-like dicts:
```
{'loss': 0.4523, 'learning_rate': 1.2e-05, 'epoch': 0.5, 'step': 50}
```

If you see `No training metrics found` in the report, check:
1. `logs/train.log` exists and is non-empty
2. Training actually ran (check checkpoint exists)
3. `logging_steps` is not too high (default 10 is fine)

TRL SFTTrainer uses the same logging format as HF Trainer — parsing is identical.
