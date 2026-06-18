# Container Invocation and End-to-End Recipe

This is the full operational detail for resolving the data-services image, mounting paths, converting a CSV source pool to parquet, and running the three embed/embed/mine commands as one streamed block.

## Resolving the image and confirming the environment

The mining and embedding tasks live inside the `tao_toolkit.data_services` image declared in `versions.yaml`. Resolve the concrete URI once at the top of the run, then confirm Docker, the NVIDIA container toolkit, and a GPU are present before doing anything else:

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

A GPU is required for both the encoder forward pass and the cuML/cuDF k-NN search; both steps will fail without CUDA.

## Container entrypoint shape

The container's entrypoint takes `<category> <action> -e <spec.yaml> [hydra overrides...]` — pass `embedding image_embeddings -e <embedding_spec.yaml> …` for embedding and `tmm nearest_neighbors -e <mining_spec.yaml> …` for mining. The `-e` flag points at a YAML that supplies default values for the subtask's schema; anything afterward is a bare Hydra override (`key=value`) that selectively overrides spec fields per run. (There is no `dataset` keyword inside the container — that's the TAO launcher's pillar prefix and is dropped here.) Pull the image once if it isn't cached: `docker pull "$DS_IMAGE"` (after resolving `$DS_IMAGE`).

Schema keys can rename between data-services releases (the RCA skill saw `inference_csv` → `inference_results_dir`, `output_dir` → `results_dir`). When in doubt, introspect the actual schema once per image: `docker run --rm "$DS_IMAGE" embedding image_embeddings --cfg=job` and `... tmm nearest_neighbors --cfg=job`.

## Path mounting

Every host path the container reads or writes — input parquets, output dirs, and the source-pool image root — must be bind-mounted. The simplest and most predictable approach is to mount the workspace root with **identical paths** inside and outside the container so the absolute paths in the parquet args resolve the same way on both sides:

```bash
WORKSPACE=<absolute path that contains all parquets, outputs, and the source-pool images>
DOCKER="docker run --gpus all --rm --ipc=host --user $(id -u):$(id -g) -v $WORKSPACE:$WORKSPACE -w $WORKSPACE $DS_IMAGE"
```

Reuse `$DOCKER` for the three invocations.

## CSV source pool conversion

If the source pool is provided only as a CSV, convert it to a parquet up front:

```python
import pandas as pd
pd.read_csv(source_pool_csv).to_parquet(source_pool_parquet, index=False)
```

The conversion must preserve the `filepath` column verbatim (and `label` if present). Do not add a path prefix — the container reads input parquets as-is, and the `$WORKSPACE` mount keeps host and container paths identical.

## Authoring the two spec files

Author the two spec files once per iteration. Both files live under `$WORKSPACE` so the `-e` argument resolves on both sides of the mount. Per-run values stay out of the spec and are passed as Hydra overrides at invocation time.

```bash
cat > "$WORKSPACE/embedding_spec.yaml" <<'EOF'
model: SigLIP                                # CLIP, SigLIP, or a TAO checkpoint
model_path: google/siglip-base-patch16-224   # HF id, local HF dir, or .pth/.ckpt
# model_config_path: <train_spec.yaml>       # required only when model_path is a TAO checkpoint
batch_size: 64
EOF

cat > "$WORKSPACE/mining_spec.yaml" <<'EOF'
topn: 5
knn_metric: cosine                           # cosine for SigLIP/CLIP; euclidean/manhattan otherwise
filter_by_label: "false"                     # quoted — the schema reads it as a string
EOF
```

Any field in either spec can still be overridden inline at the CLI (e.g. `topn=10`) — Hydra applies CLI overrides on top of the spec.

## The three commands, in order

Three commands, in order. Each command's output parquet is the next command's input. Run them as plain Bash; the `$DOCKER` alias handles the container, GPU, and mounts. Every invocation follows the same shape: `-e <spec>` for the baked-in defaults, then a handful of Hydra overrides for the run-specific paths.

### Step 1 — Embed the target images

```bash
$DOCKER embedding image_embeddings \
    -e <embedding_spec.yaml> \
    input_parquet=<target_parquet> \
    output_parquet=<target_embeddings_parquet>
```

Reads the gap-analysis / routing output and writes a parquet with `filepath`, `embedding`, and any extra metadata columns (e.g. `label`, `siamese_score`, `weakness`) carried forward verbatim from the input. Print the output schema (`pd.read_parquet(...).columns`) to stdout so the script-check hook can confirm the embedding column exists.

If you need to override `model` / `model_path` / `batch_size` for one run without editing the spec, append them as Hydra overrides (e.g. `model_path=...`).

### Step 2 — Embed the source pool

```bash
$DOCKER embedding image_embeddings \
    -e <embedding_spec.yaml> \
    input_parquet=<source_pool_parquet> \
    output_parquet=<source_embeddings_parquet>
```

Same command shape as Step 1, applied to the source pool. Use the **identical** `embedding_spec.yaml` as Step 1, and do not override `model` / `model_path` / `batch_size` differently here — mismatched encoder configs across the two steps produce non-comparable embeddings.

### Step 3 — Mine nearest neighbours

```bash
$DOCKER tmm nearest_neighbors \
    -e <mining_spec.yaml> \
    source_parquet=<source_embeddings_parquet> \
    target_parquet=<target_embeddings_parquet> \
    output_parquet=<mined_parquet>
```

For each target embedding, finds the `topn` closest source embeddings under the chosen metric, deduplicates across targets, and writes a single-column (`filepath`) parquet of unique mined source paths. The container also drops a `mining_summary.txt` next to the output parquet with: query count, neighbour count, duplicates removed, and (when label filtering is on) kept-vs-dropped pair counts. Tweak `topn`, `knn_metric`, or `filter_by_label` via inline Hydra override when sweeping (e.g. `topn=10`) — no need to rewrite the spec.

When `filter_by_label=true` but one of the embedding parquets is missing the `label` column, the container logs a warning and proceeds without filtering. If the mined output looks larger than expected or contains cross-label pairs, scan the docker log for that warning before assuming the task did the right thing.

## Minimal end-to-end recipe

This is the minimal end-to-end recipe — paste-and-edit the workspace, the three parquet paths, and the encoder, and it runs. Run as a single Bash block so the script-check hook sees one streamed log.

```bash
WORKSPACE=<absolute path>           # mounted identically inside the container
TARGETS=<target_parquet>            # e.g. .../routing_results/<ts>/mining_gaps.parquet
SOURCE_POOL=<source_pool_parquet>   # parquet with `filepath` (and optional `label`)
OUT="$WORKSPACE/mining_results/$(date +%Y-%m-%d_%H%M%S)"
EMBED_SPEC="$OUT/embedding_spec.yaml"
MINE_SPEC="$OUT/mining_spec.yaml"
MODEL=SigLIP                        # or CLIP, or a TAO checkpoint name
MODEL_PATH=google/siglip-base-patch16-224  # or a local checkpoint path
TOPN=5
METRIC=cosine
FILTER_BY_LABEL=false
IMG=$(python3 -c "import yaml,os; print(yaml.safe_load(open(os.environ['TAO_SKILL_BANK_PATH']+'/versions.yaml'))['images']['tao_toolkit']['data_services'])")

mkdir -p "$OUT"

# Write the two spec files for this iteration
cat > "$EMBED_SPEC" <<EOF
model: $MODEL
model_path: $MODEL_PATH
batch_size: 64
EOF

cat > "$MINE_SPEC" <<EOF
topn: $TOPN
knn_metric: $METRIC
filter_by_label: "$FILTER_BY_LABEL"
EOF

# Step 1: embed targets
docker run --gpus all --rm --ipc=host \
    --user "$(id -u):$(id -g)" \
    -v "$WORKSPACE:$WORKSPACE" -w "$WORKSPACE" \
    "$IMG" embedding image_embeddings \
    -e "$EMBED_SPEC" \
    input_parquet="$TARGETS" \
    output_parquet="$OUT/target_embeddings.parquet"

# Step 2: embed source pool (SAME embedding spec as Step 1)
docker run --gpus all --rm --ipc=host \
    --user "$(id -u):$(id -g)" \
    -v "$WORKSPACE:$WORKSPACE" -w "$WORKSPACE" \
    "$IMG" embedding image_embeddings \
    -e "$EMBED_SPEC" \
    input_parquet="$SOURCE_POOL" \
    output_parquet="$OUT/source_embeddings.parquet"

# Step 3: mine nearest neighbours
docker run --gpus all --rm --ipc=host \
    --user "$(id -u):$(id -g)" \
    -v "$WORKSPACE:$WORKSPACE" -w "$WORKSPACE" \
    "$IMG" tmm nearest_neighbors \
    -e "$MINE_SPEC" \
    source_parquet="$OUT/source_embeddings.parquet" \
    target_parquet="$OUT/target_embeddings.parquet" \
    output_parquet="$OUT/mined.parquet"

# Sanity print so the script-check hook sees row counts
python3 -c "
import pandas as pd
for name, p in [('target_embeddings', '$OUT/target_embeddings.parquet'),
                ('source_embeddings', '$OUT/source_embeddings.parquet'),
                ('mined',             '$OUT/mined.parquet')]:
    df = pd.read_parquet(p)
    print(f'{name}: rows={len(df)}, cols={list(df.columns)}')
"
```

Print the row counts and column lists at the end so the script-check hook can verify each step actually produced output.
