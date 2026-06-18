---
name: tao-analyze-gaps-visual-changenet
description: Performs gap analysis on NVIDIA TAO Visual ChangeNet (VCN) Classify experiments by invoking the data-services
  container (`tao_toolkit.data_services` from `versions.yaml`) directly via `docker run … gap_analysis vcn_aoi …` — picks
  the optimal decision threshold, ranks per-sample weakness, and emits a top-K weakest parquet expanded per-lighting for
  downstream augmentation. Use when analyzing VCN classification failures, picking SDA augmentation targets, auditing
  PASS/NO_PASS boundary cases, or running DEFT gap analysis on an AOI ChangeNet model.
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit and a CUDA GPU. Pulls the `tao_toolkit.data_services` image declared in `versions.yaml` at the skill bank root.
metadata:
  author: NVIDIA Corporation
  version: "0.3.0"
allowed-tools: Read Bash
tags:
- data
- rca
- vcn
- aoi
---

# TAO VCN Classify Gap Analysis Skill

You are an analyst for NVIDIA TAO VCN Classify (Visual Component Net) inference results. Your job is to identify the **weakest samples per ground-truth label** by measuring signed distance from the decision threshold *in the wrong direction*, then surface them for downstream augmentation or relabeling.

This skill is intentionally lightweight. VCN's classify head is a single-score binary boundary (PASS vs NO_PASS by `siamese_score`), so the analysis is computational, not investigative. The whole computation lives behind one direct `docker run` invocation against the `tao_toolkit.data_services` image declared in `versions.yaml` (resolved at runtime — see Setup). The container's entrypoint takes `<category> <action> [hydra overrides...]`; we pass `gap_analysis vcn_aoi key=value …`. You do **not** need subagents, multi-phase image audits, or component-type clustering — VCN does not expose those dimensions. View only a small set of representative weak samples to qualify the gaps after the container returns.

The CLI surface can shift between data-services container builds. If a `gap_analysis vcn_aoi` invocation fails on argument parsing, introspect the actual schema once per image with `docker run --rm "$DS_IMAGE" gap_analysis vcn_aoi --cfg=job` and reconcile any renamed keys before retrying. See `references/troubleshooting.md` for the key-rename reconciliation and the full pitfalls list. The output parquet name is `kpi_gaps.parquet`.

---

## Inputs

1. **Experiment result directory** — contains `inference/inference.csv` (required columns `input_path`, `object_name`, `label`, `siamese_score`). Pass the **directory** (e.g. `inference/latest/`), not the CSV file.
2. **Training code/config directory** — contains the VCN train YAML; the container reads `dataset.classify.input_map` and `dataset.classify.image_ext` for per-lighting expansion.
3. **Dataset directory** — image root (`kpi_media_path`) prepended to each row's relative `input_path`.
4. **Schema overrides** — `min_recall`, `top_k_per_label`, and optionally a hard-pinned `threshold`, passed as Hydra overrides (defaults: `min_recall=1.0`, `top_k_per_label=50`, `threshold=-1.0` meaning sweep). **`top_k_per_label` must be a positive integer** — omitting it flips the container into "below-threshold filter" mode, which at `min_recall=1.0` returns only PASS misclassifications and zero NO_PASS rows.

See `references/parameters-and-artifacts.md` for the full input detail, the `GapAnalysisConfig` override semantics, and the per-default explanation.

---

## Setup

The threshold sweep, weakness ranking, and per-lighting expansion all run inside the `tao_toolkit.data_services` image declared in `versions.yaml`. Resolve the concrete URI once at the top of the run, then confirm Docker, the NVIDIA container toolkit, and a GPU are present and ensure the image is cached:

```bash
# Resolve tao_toolkit.data_services → concrete nvcr.io/... URI from versions.yaml
DS_IMAGE=$(python3 -c "import yaml,os; print(yaml.safe_load(open(os.environ['TAO_SKILL_BANK_PATH']+'/versions.yaml'))['images']['tao_toolkit']['data_services'])")
echo "DS_IMAGE=$DS_IMAGE"

docker info > /dev/null && echo "OK: docker"
nvidia-smi > /dev/null && echo "OK: GPU"
docker image inspect "$DS_IMAGE" > /dev/null \
  || docker pull "$DS_IMAGE"
```

`TAO_SKILL_BANK_PATH` is exported by the plugin's `session_start` hook. If it is unset (e.g. running outside the Claude Code plugin), point it at the skill-bank repo root before resolving.

A GPU is required (the same image is used across the AOI loop and other actions assume CUDA is present). Aborting early on a GPU-less host saves a confusing late error.

**Path mounting.** Every host path the container reads or writes — `inference.csv`, the train YAML, the dataset image root, and the output dir — must be bind-mounted. The simplest pattern is to mount the workspace root with **identical paths** inside and outside the container so absolute paths in args resolve the same on both sides:

```bash
WORKSPACE=<absolute path that contains inference.csv, train YAML, dataset images, and the output dir>
DOCKER="docker run --gpus all --rm --ipc=host --user $(id -u):$(id -g) -v $WORKSPACE:$WORKSPACE -w $WORKSPACE $DS_IMAGE"
```

If `inference.csv`, the train YAML, and the dataset images live in different roots, pass multiple `-v` flags — but every absolute path you pass in args must resolve inside the container.

**CLI overrides cover the common case.** `min_recall`, `top_k_per_label`, and optionally `threshold` are passed as Hydra overrides on the command line; defaults baked into the container (`min_recall=1.0`, `top_k_per_label=50`, `threshold=-1.0` to sweep) handle most runs. If the container also accepts a spec file via `-e <spec>` (verify with `--cfg=job`), passing one is a convenience, not a requirement — override only what you need.

---

## Method

The whole skill is a single `docker run` invocation followed by a small visual spot-check. The container does Steps 1–4 internally (threshold sweep, weakness scoring, top-K selection, per-lighting expansion). You handle Step 5 (visual spot-check) directly with the Read tool.

### Step 1–4 — Run the container

```bash
$DOCKER gap_analysis vcn_aoi \
    inference_results_dir=<exp_dir>/inference/<label>/ \
    train_config=<exp_dir>/train.yaml \
    kpi_media_path=<dataset_root> \
    results_dir=<rca_results_dir> \
    top_k_per_label=50
```

> **Always pass `top_k_per_label`.** This is the argument that switches the container
> from the default "samples below threshold" filter into proper top-K-per-label
> ranking. At `min_recall=1.0` the threshold is by construction at-or-below every
> NO_PASS score, so the below-threshold filter returns ONLY misclassified PASS rows
> and zero NO_PASS rows — useless as an augmentation queue. With `top_k_per_label`
> set to a positive integer (either in the spec or as a Hydra override), the
> container computes signed weakness against the threshold for every row and
> surfaces the K weakest **per ground-truth label**, which is the per-label ranked
> output downstream steps consume.

The container sweeps every unique `siamese_score` (plus one value just below the minimum), keeps candidates with NO_PASS recall ≥ `min_recall` (tolerance `1e-12`), picks the best-F1 threshold (tie-break: precision, then threshold value), scores signed weakness per row, takes the top `top_k_per_label` per ground-truth label, and expands each into one row per lighting. See `references/parameters-and-artifacts.md` for the exact computation, the override defaults, and the artifact table.

If **no** candidate threshold meets the recall target, the container exits non-zero and writes `unreachable_kpi.txt` into `results_dir` explaining which recall the model can actually achieve. In that case, stop the analysis after the docker call, write a one-section report explaining the model fundamentally cannot reach the KPI at any operating point, and recommend retraining or relabeling — skip the visual spot-check.

**Container writes into `results_dir`:** `kpi_gaps.parquet` (top-K weakest per label, expanded per lighting; columns `filepath`, `label`, `siamese_score`, `weakness`), `threshold.txt`, `metrics.json`, `weak_samples_breakdown.txt`, and `unreachable_kpi.txt` (only when the recall target is unreachable). See `references/parameters-and-artifacts.md` for the per-artifact contents. Print the container's stdout summary (chosen threshold, kept-row counts, per-label breakdown) to your own stdout so the script-check hook can verify the run produced output.

### Step 5 — Visual spot check (small, fixed)

Skip this step if `unreachable_kpi.txt` exists in `results_dir` — there is nothing meaningful to spot-check when the model can't reach the KPI at any threshold.

Otherwise, use the Read tool to **view** the test images for:

- The 5 weakest PASS samples (the top of the "PASS misclassified as NO_PASS" pile) — pick by sorting `kpi_gaps.parquet` rows where `label == 'PASS'` by `weakness` descending.
- The 5 weakest NO_PASS samples (the top of the "NO_PASS misclassified as PASS" pile) — same, with `label != 'PASS'`.

`kpi_gaps.parquet` is already expanded per-lighting (multiple rows per sample). For the spot check, deduplicate to one row per (input_path, object_name) — pick the row whose `filepath` uses the FIRST lighting from the train YAML (one image per sample is enough — VCN's classify head sees all lightings stacked, but for human spot-check one is representative).

Classify each viewed sample as exactly one of:
- **mislabeled** — visual content disagrees with the CSV label
- **edge case** — genuinely ambiguous boundary case
- **data quality** — corrupted, dark, wrong crop, bad framing
- **systematic** — model has learned the wrong feature (the image looks "obviously PASS/NO_PASS" but the model disagrees)

Copy each viewed image (resized to 128×128 if PIL is available, otherwise just copy) into `<results_dir>/rca_images/` so it can be embedded inline in the report.

This is the **only** image inspection required. Do not view dozens of images, do not run failure mode clustering, do not audit goldens — VCN does not have golden images.

---

## Reference invocation

The paste-and-edit end-to-end recipe (workspace, four paths, two numeric knobs, spec-file write, docker run, and the stdout sanity print that surfaces row counts for the script-check hook) lives in `references/recipe.md`. Use it verbatim, editing only the workspace, paths, and knobs.

---

## Outputs

Write everything into a timestamped folder under the experiment result directory: `<experiment_result_dir>/rca_results/YYYY-MM-DD_HHMMSS/`. The container's outputs (`kpi_gaps.parquet`, `threshold.txt`, `metrics.json`, `weak_samples_breakdown.txt`, and `unreachable_kpi.txt` when applicable) go straight there; the visual spot-check writes `rca_images/`; the packaging hook adds `rca_config/` and `claude_session.jsonl` automatically when `RCA_Report.md` is written. See `references/parameters-and-artifacts.md` for the full folder tree.

At the start of the run, get the real timestamp by running `date +%Y-%m-%d_%H%M%S` in Bash. Do NOT hardcode or guess. If the user specifies a custom output path, use that instead but maintain the same internal structure.

---

## Common pitfalls

The most consequential failure is **forgetting `top_k_per_label` when `min_recall=1.0`** — at that recall the chosen threshold sits at or below every NO_PASS score, so the fallback below-threshold filter matches ONLY misclassified PASS rows and `kpi_gaps.parquet` ends up with zero NO_PASS rows. Always include an explicit positive `top_k_per_label`. The full pitfalls list (spec file outside `$WORKSPACE`, unresolved `???` sentinels, wrong/unpulled image tag, path-mount mismatch, `unreachable_kpi.txt` handling, missing `inference.csv` columns, missing train-YAML keys, `kpi_media_path` prefix mismatch, no GPU inside the container) and the CLI-drift reconciliation are in `references/troubleshooting.md`.

---

## Report Structure

Write the RCA report into the timestamped output folder. It is a 7-section computational gap analysis (Verdict, Threshold Selection, Weakness Distribution, Top-K Weakest Samples, Visual Spot Check, Per-Label Breakdown, Recommended Actions), 1000–1800 words, with the confusion-matrix and per-label tables filled from `metrics.json` and the spot-check rows from `kpi_gaps.parquet`. When `unreachable_kpi.txt` exists, replace sections 3–6 with one short section quoting that file and collapse section 7 to a single retrain-or-relabel recommendation. See `references/rca-report-structure.md` for the complete skeleton with every section heading, table layout, and the unreachable-KPI variant.

---

## Execution Order

1. Resolve `DS_IMAGE` from `versions.yaml` (`images.tao_toolkit.data_services`), then run `docker info`, `nvidia-smi`, and `docker image inspect "$DS_IMAGE"` (pulling if missing) once to confirm the environment. Abort with a clear message if any fail.
2. Run `date +%Y-%m-%d_%H%M%S` to get the timestamp; create `<experiment_result_dir>/rca_results/<timestamp>/`.
3. Write `vcn_aoi_spec.yaml` into the timestamped dir with `min_recall` and `top_k_per_label` filled in. Keep it under `$WORKSPACE` so the `-e` path resolves inside the container.
4. Run `docker run … "$DS_IMAGE" gap_analysis vcn_aoi -e vcn_aoi_spec.yaml inference_results_dir=… train_config=… kpi_media_path=… output_dir=…`. The container writes `kpi_gaps.parquet`, `threshold.txt`, `metrics.json`, `weak_samples_breakdown.txt` into `results_dir`. Print the chosen threshold and kept-row counts to stdout so the script-check hook can verify the run produced output.
5. If `unreachable_kpi.txt` exists, skip Step 6 and write the abridged report. Otherwise continue.
6. Pick 10 weak samples (5 weakest PASS + 5 weakest NO_PASS) from `kpi_gaps.parquet`, view each test image with Read, classify, and copy each into `rca_images/`.
7. Write `RCA_Report.md` last — writing it triggers the packaging hook, which copies session logs and skill config alongside.
