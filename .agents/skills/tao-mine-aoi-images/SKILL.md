---
name: tao-mine-aoi-images
description: Runs the DEFT embed-then-mine workflow for VCN AOI iterations — embeds the gap-analysis target parquet, embeds
  a source pool, and mines nearest-neighbour source images for downstream augmentation. Use as the immediate next step after
  `tao-route-visual-changenet-samples` when expanding a real-image augmentation queue from the mining subset.
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit and a CUDA GPU. Pulls the `tao_toolkit.data_services` image declared in `versions.yaml` at the skill bank root.
metadata:
  author: NVIDIA Corporation
  version: "0.2.0"
allowed-tools: Read Bash
tags:
- data
- mining
- embedding
- vcn
- aoi
- sda
---

# DEFT Mining and Embedding Skill

You are the operator of the DEFT embed-then-mine workflow for VCN AOI. Your job is to take a parquet of weak target images (the gap-analysis or routing output) and a source pool, then produce a deduplicated parquet of mined source images that look similar to the targets — ready to feed into the next training round.

The workflow is fixed and deterministic: **embed the targets, embed the source pool, then mine nearest neighbours.** Each step's output parquet is the next step's input. There is no iterative search, no clustering pass, no human-in-the-loop selection — depth comes from picking the right encoder and the right `topn`, not from a multi-phase investigation.

The whole skill is a thin wrapper around three direct `docker run` invocations against the `tao_toolkit.data_services` image declared in `versions.yaml` (resolved at runtime — see Setup). The container's entrypoint takes `<category> <action> -e <spec.yaml> [hydra overrides...]`: `embedding image_embeddings -e <embedding_spec.yaml> …` for embedding and `tmm nearest_neighbors -e <mining_spec.yaml> …` for mining. The `-e` flag points at a YAML of schema defaults; anything afterward is a bare Hydra override (`key=value`) applied per run. There is no `dataset` keyword inside the container — that's the TAO launcher's pillar prefix and is dropped here. Schema keys can rename between data-services releases, so when in doubt introspect once per image with `docker run --rm "$DS_IMAGE" embedding image_embeddings --cfg=job` and `... tmm nearest_neighbors --cfg=job`. See `references/invocation.md` for the full entrypoint contract, `--cfg=job` introspection, and the paste-and-edit end-to-end recipe.

---

## Inputs

1. **Target parquet** — the gap-analysis output, typically `mining_gaps.parquet` from `tao-route-visual-changenet-samples` (or `gaps.parquet` from `tao-analyze-gaps-visual-changenet` if routing was skipped). Required column: `filepath`. If `label` is also present, label-aware filtering during mining is available; otherwise the mining task silently no-ops the filter.
2. **Source pool** — a parquet of candidate images to mine against, with a `filepath` column. If the user only has a CSV, convert it to a parquet **with the same columns** before Step 2. For label-aware filtering, the pool must also carry a `label` column.
3. **Embedding spec file** — a YAML containing `model`, `model_path`, `batch_size`, and (only when `model_path` is a TAO `.pth`/`.ckpt`) `model_config_path`. Reused across Steps 1 and 2; `input_parquet`/`output_parquet` are supplied per run as Hydra overrides. The **same** spec MUST drive both embedding steps — embeddings from different encoders are not comparable, and mismatched encoders are the most common cause of "the mined images look unrelated" reports.
4. **Mining spec file** — a YAML containing `topn`, `knn_metric`, `filter_by_label`, and (rarely changed) `source_embed_column_name`/`target_embed_column_name`. `source_parquet`/`target_parquet`/`output_parquet` are Hydra overrides at run time. SigLIP and CLIP embeddings should use `knn_metric: cosine`. When `filter_by_label: true` but either embedding parquet lacks a `label` column, the container logs a warning and proceeds **without** filtering.

---

## Setup

The mining and embedding tasks live inside the `tao_toolkit.data_services` image declared in `versions.yaml`. Resolve the concrete URI once at the top of the run, then confirm Docker, the NVIDIA container toolkit, and a GPU are present before anything else:

```bash
# Resolve tao_toolkit.data_services → concrete nvcr.io/... URI from versions.yaml
DS_IMAGE=$(python3 -c "import yaml,os; print(yaml.safe_load(open(os.environ['TAO_SKILL_BANK_PATH']+'/versions.yaml'))['images']['tao_toolkit']['data_services'])")
echo "DS_IMAGE=$DS_IMAGE"

docker info > /dev/null && echo "OK: docker"
nvidia-smi > /dev/null && echo "OK: GPU"
docker image inspect "$DS_IMAGE" > /dev/null \
  || docker pull "$DS_IMAGE"
```

`TAO_SKILL_BANK_PATH` is exported by the plugin's `session_start` hook. If it is unset (e.g. running outside the Claude Code plugin), point it at the skill-bank repo root before resolving. A GPU is required for both the encoder forward pass and the cuML/cuDF k-NN search; both steps will fail without CUDA.

**Path mounting.** Every host path the container reads or writes — input parquets, output dirs, and the source-pool image root — must be bind-mounted. The simplest, most predictable approach mounts the workspace root with **identical paths** inside and outside the container so absolute paths in the parquet args resolve the same way on both sides:

```bash
WORKSPACE=<absolute path that contains all parquets, outputs, and the source-pool images>
DOCKER="docker run --gpus all --rm --ipc=host --user $(id -u):$(id -g) -v $WORKSPACE:$WORKSPACE -w $WORKSPACE $DS_IMAGE"
```

Reuse `$DOCKER` for the three invocations below.

**CSV source pool.** If the source pool is provided only as a CSV, convert it to a parquet up front with `pd.read_csv(...).to_parquet(..., index=False)`, preserving the `filepath` column verbatim (and `label` if present). Do not add a path prefix — the container reads input parquets as-is and the `$WORKSPACE` mount keeps host and container paths identical.

**Author the two spec files once per iteration.** Both files live under `$WORKSPACE` so the `-e` argument resolves on both sides of the mount. Per-run values stay out of the spec and are passed as Hydra overrides at invocation time. The defaults are `model: SigLIP`, `model_path: google/siglip-base-patch16-224`, `batch_size: 64` for embedding, and `topn: 5`, `knn_metric: cosine`, `filter_by_label: "false"` (quoted — the schema reads it as a string) for mining. Use `cosine` for SigLIP/CLIP, `euclidean`/`manhattan` otherwise; add `model_config_path` only when `model_path` is a TAO checkpoint. Any field can still be overridden inline at the CLI (e.g. `topn=10`) — Hydra applies CLI overrides on top of the spec.

See `references/invocation.md` for the verbatim spec-file templates, the CSV conversion snippet, and the full mounting and image-resolution detail.

---

## Method

Three commands, in order. Each command's output parquet is the next command's input. Run them as plain Bash; the `$DOCKER` alias from Setup handles the container, GPU, and mounts. Every invocation follows the same shape: `-e <spec>` for the baked-in defaults, then a handful of Hydra overrides for run-specific paths.

### Step 1 — Embed the target images

```bash
$DOCKER embedding image_embeddings -e <embedding_spec.yaml> \
    input_parquet=<target_parquet> output_parquet=<target_embeddings_parquet>
```

Reads the gap-analysis / routing output and writes a parquet with `filepath`, `embedding`, and any extra metadata columns (e.g. `label`, `siamese_score`, `weakness`) carried forward verbatim. Print the output schema (`pd.read_parquet(...).columns`) to stdout so the script-check hook can confirm the embedding column exists. To override `model` / `model_path` / `batch_size` for one run without editing the spec, append them as Hydra overrides.

### Step 2 — Embed the source pool

```bash
$DOCKER embedding image_embeddings -e <embedding_spec.yaml> \
    input_parquet=<source_pool_parquet> output_parquet=<source_embeddings_parquet>
```

Same command shape as Step 1, applied to the source pool. Use the **identical** `embedding_spec.yaml` as Step 1, and do not override `model` / `model_path` / `batch_size` differently here — mismatched encoder configs across the two steps produce non-comparable embeddings.

### Step 3 — Mine nearest neighbours

```bash
$DOCKER tmm nearest_neighbors -e <mining_spec.yaml> \
    source_parquet=<source_embeddings_parquet> \
    target_parquet=<target_embeddings_parquet> output_parquet=<mined_parquet>
```

For each target embedding, finds the `topn` closest source embeddings under the chosen metric, deduplicates across targets, and writes a single-column (`filepath`) parquet of unique mined source paths. The container also drops a `mining_summary.txt` next to the output parquet with: query count, neighbour count, duplicates removed, and (when label filtering is on) kept-vs-dropped pair counts. Tweak `topn`, `knn_metric`, or `filter_by_label` via inline Hydra override when sweeping — no need to rewrite the spec. When `filter_by_label=true` but one embedding parquet is missing the `label` column, the container logs a warning and proceeds without filtering; if the mined output looks too large or contains cross-label pairs, scan the docker log for that warning first.

See `references/invocation.md` for the complete paste-and-edit recipe that runs all three steps as one streamed Bash block with row-count sanity prints.

---

## Outputs

Write everything into a timestamped folder under the experiment / iteration directory. The packaging hook will add `mining_config/` and `claude_session.jsonl` automatically when `Mining_Report.md` is written.

```
<output_dir>/mining_results/YYYY-MM-DD_HHMMSS/
├── Mining_Report.md            # Full mining report
├── embedding_spec.yaml         # The -e spec used for Steps 1 and 2
├── mining_spec.yaml            # The -e spec used for Step 3
├── target_embeddings.parquet   # Step 1 output (filepath, embedding, + carried metadata)
├── source_embeddings.parquet   # Step 2 output (filepath, embedding, + carried metadata)
├── mined.parquet               # Step 3 output — unique mined source filepaths
├── mining_summary.txt          # Auto-emitted next to mined.parquet by the container
├── mining_config/              # Auto-copied by hook
└── claude_session.jsonl        # Auto-copied by hook
```

At the start of the run, get the real timestamp by running `date +%Y-%m-%d_%H%M%S` in Bash. Do NOT hardcode or guess. If the user specifies a custom output path, use it directly but maintain the same internal layout.

The mined parquet is the artifact downstream training consumes. The two embedding parquets are intermediate but worth retaining: they are reusable across multiple mining runs against the same source pool, and they are the only place to look when a "looks unrelated" report needs encoder-level debugging.

---

## Common pitfalls

The single most common cause of garbage output is **mismatched encoders** — both embedding steps must consume the same `embedding_spec.yaml`, and any `model` / `model_path` / `batch_size` override must apply to both steps or neither. Other frequent issues: skipping an embedding step, a missing `label` column under `filter_by_label=true` (silent no-op), spec files outside `$WORKSPACE`, unresolved `???` sentinels, TAO checkpoints without `model_config_path`, CSV pools not converted to parquet, host/container path mismatches, no GPU, the wrong image tag, and `topn` × N_targets exceeding the source size (expected, not a bug — report the actual mined count).

See `references/troubleshooting.md` for the full diagnosis and fix for each of these.

---

## Report Structure

Keep the report tight (600–1200 words). Mining is a deterministic pipeline; the value is making the encoder choice, the row counts, and any silent filter no-ops auditable — not narrative. The report has seven sections: Verdict, Inputs, Encoder Consistency, Mining Run, Per-Label Breakdown (skipped if the target parquet has no `label` column), Output Sanity, and Recommended Actions.

See `references/reporting_spec.md` for the complete fill-in report template with every section and field.

---

## Execution Order

1. Resolve `DS_IMAGE` from `versions.yaml` (`images.tao_toolkit.data_services`), then run `docker info`, `nvidia-smi`, and `docker image inspect "$DS_IMAGE"` (pulling if missing) once to confirm the environment. Abort with a clear message if any fail.
2. Run `date +%Y-%m-%d_%H%M%S` to get the timestamp; create `<output_dir>/mining_results/<timestamp>/`.
3. Write `embedding_spec.yaml` and `mining_spec.yaml` into the timestamped dir, filling in the encoder choice and mining knobs. Keep these under `$WORKSPACE` so the `-e` path resolves inside the container.
4. If the source pool is a CSV, convert to parquet first (preserve `filepath` and `label`).
5. Run Step 1 (embed targets) via `docker run … embedding image_embeddings -e embedding_spec.yaml input_parquet=… output_parquet=…`. Print the output parquet's row count and columns to stdout.
6. Run Step 2 (embed source pool) with the **identical** `embedding_spec.yaml` as Step 1. Print output row count and columns.
7. Run Step 3 (mine nearest neighbours) via `docker run … tmm nearest_neighbors -e mining_spec.yaml source_parquet=… target_parquet=… output_parquet=…`. Confirm `mining_summary.txt` was written next to `mined.parquet`.
8. Compute the per-label breakdown (Section 5) by joining the target embeddings parquet with the mined output on filepath, if both carry `label`.
9. Write `Mining_Report.md` last — writing it triggers the packaging hook, which copies session logs and skill config alongside.
