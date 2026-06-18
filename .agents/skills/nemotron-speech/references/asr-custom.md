# Riva ASR Custom Model Deployment

> **Agent:** Announce each phase before presenting it: **Phase N/4 — Phase Title** (e.g., "**Phase 1/4 — Obtain a .riva File**").
>
> **Source of truth.** This skill describes the 4-phase custom-deployment workflow, which is stable. For per-release detail — per-model `riva-build` syntax, the inline `nemo2riva` source_path config (in the **Notes sections** under each model on the pipeline-configuration page), supported architectures, NGC artifact paths — **fetch or open the canonical doc page or run `riva-build -h` inside the container.** See [Looking up current information](#looking-up-current-information) below.

## Purpose

Deploy a custom or modified ASR pipeline as a Riva NIM when pre-built NIMs do not meet accuracy, vocabulary, or pipeline-configuration requirements. Covers the full pipeline: obtain a deployable `.riva` checkpoint, build an RMIR, deploy the model repository, and launch the NIM. If the user has their own fine-tuned `.nemo` checkpoint, use the inline `nemo2riva` method inside `riva-build`; do not point them to a separate `nemo2riva` GitHub repo.

## Looking up current information

| Question type | Fetch this page |
|---|---|
| **Per-model `riva-build` syntax, inline `nemo2riva` source_path config (in the Notes sections under each model), supported NeMo architectures, decoder / VAD / diarizer flags** | https://docs.nvidia.com/nim/speech/latest/asr/customization/pipeline-configuration.html |
| Current NGC `_finetune` artifacts (`deployable` `.riva` and `trainable` `.nemo` versions) | https://catalog.ngc.nvidia.com/orgs/nim/teams/nvidia/models |
| Which base NIM container image to use for a given model family | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html |
| GPU / VRAM / driver minimums | https://docs.nvidia.com/nim/speech/latest/get-started/prerequisites.html |
| Live, version-accurate parameter list (run inside the container) | `riva-build --config-path=pkg://servicemaker.configs.asr --config-name=<streaming\|offline> -h` |

**Do not infer from this skill's text:** which base container image to use for a specific model family, the exact `nemo2riva` inline-config block for a given architecture, or what the current `riva-build` defaults are. The pipeline-configuration page (per-model build commands + Notes sections), NGC catalog, and `--help` output are authoritative.

## Workflow

4-phase pipeline: obtain a `.riva` file → build an RMIR with `riva-build` → deploy the model repository with `riva-deploy` → launch the custom NIM.

## Prerequisites

- Complete [`setup.md`](setup.md): NVIDIA Container Toolkit, `NGC_API_KEY` exported (driver minimum: see prerequisites page cited above)
- If no NeMo fine-tuning was performed, use a `deployable_vX.Y` `.riva` artifact from the model's NGC `_finetune` package.
- Use `trainable_vX.Y` / `.nemo` only when the user has fine-tuned or is fine-tuning with NeMo. Fine-tuned `.nemo` checkpoints are passed directly to `riva-build` via the inline `nemo2riva` `source_path` config. The exact inline config must be copied from the **Notes section for that model** in the pipeline configuration page.

## Instructions

Follow the 4-phase pipeline below. Run `riva-build` and `riva-deploy` inside the NIM container (enter with `--entrypoint /bin/bash`). All paths like `/riva_build_deploy/` refer to the mounted directory inside the container.

For pipeline configuration options at build time (decoder, VAD, language model, diarizer): see [`pipelines.md`](pipelines.md).
For runtime customizations that don't require a rebuild: fetch the customization page (cited in [`pipelines.md`](pipelines.md) routing table).

## Phase 1 — Obtain a `.riva` or `.nemo` File

Two sources:

**Option A — Download a deployable `.riva` artifact from NGC** (default if you have not fine-tuned):

```bash
ngc registry model download-version \
  nim/nvidia/<model-name>_finetune:<version> \
  --dest /path/to/artifacts/
```

Use `deployable_vX.Y` versions from the model's `_finetune` package. These contain the `.riva` file ready for `riva-build` and are the right source when you only need to change Riva pipeline parameters such as decoder, VAD, diarization, endpointing, or chunk/context settings. `trainable_vX.Y` versions contain `.nemo` assets for NeMo fine-tuning, not direct deployment.

**Option B — Use your own fine-tuned NeMo checkpoint (`.nemo`):**

Do this only when the user has a `.nemo` checkpoint from NeMo fine-tuning. Pass the `.nemo` file directly to `riva-build` via the inline `nemo2riva` block in `source_path` (Phase 2). The inline-config syntax is **per model family** and is documented in the **Notes section for each model** in the table where build commands are documented on the pipeline-configuration page:

https://docs.nvidia.com/nim/speech/latest/asr/customization/pipeline-configuration.html

Examples of the inline block (verify the exact form for your model family on the page above):

| Model family | Typical `nemo2riva` inline block |
|---|---|
| CTC (Parakeet CTC, Conformer) | `{nemo2riva: {format:onnx, onnx_opset:19, max_dim:1000}}` |
| RNNT (Parakeet RNNT) | `{nemo2riva: {format:nemo}}` |

The inline-config values, supported architectures, and any new model-family-specific keys can change per release — always cross-check the model's Notes section. Do not recommend a separate `nemo2riva` GitHub repo; use the inline method documented for `riva-build`.

---

## Phase 2 — Build RMIR with `riva-build`

Run `riva-build` inside the NIM container. This creates the RMIR (Riva Model Intermediate Representation) file.

The base NIM container image must match the model family / architecture you're deploying. Fetch the support matrix to find the right base image for your model family.

```bash
export CONTAINER_ID=<base-NIM-image-matching-your-model-family>
export NIM_EXPORT_PATH=~/nim_export
export ARTIFACT_DIR=/path/to/artifacts         # directory containing your .riva file

mkdir -p $NIM_EXPORT_PATH && sudo chown 1000:1000 $NIM_EXPORT_PATH

```

See [setup.md → Cache directory ownership](setup.md#cache-directory-ownership) for the `chown 1000:1000` rationale.

```bash

# Launch interactive shell inside the NIM container
docker run --gpus all -it --rm \
  --ulimit nofile=65536:65536 \
  -v $ARTIFACT_DIR:/riva_build_deploy \
  -v $NIM_EXPORT_PATH:/model_tar \
  --entrypoint="/bin/bash" \
  --name riva-build-deploy \
  nvcr.io/nim/nvidia/$CONTAINER_ID:latest
```

> **`--ulimit nofile=65536:65536`** raises the file-descriptor cap inside the build container. Without it, certain large-model edge cases (e.g., ONNX models with external weight files) can cascade into `OSError: Too many open files` during cleanup.

Inside the container, run `riva-build`. The shape varies depending on whether you have a `.riva` artifact or a `.nemo` checkpoint:

Choose `--config-name=streaming` or `--config-name=offline` based on your deployment mode. The `--config-path=pkg://servicemaker.configs.asr` flag is the same for all ASR pipelines.

**Starting from a `.riva` artifact:**

```bash
riva-build --config-path=pkg://servicemaker.configs.asr --config-name=<streaming|offline> \
  output_path=/riva_build_deploy/custom_model.rmir \
  'source_path=[/riva_build_deploy/model.riva]'

# Force overwrite if .rmir already exists — pass force=true as a config parameter
# (riva-build does NOT accept a -f CLI flag; only riva-deploy does)
riva-build --config-path=pkg://servicemaker.configs.asr --config-name=<streaming|offline> \
  force=true \
  output_path=/riva_build_deploy/custom_model.rmir \
  'source_path=[/riva_build_deploy/model.riva]'

# With encryption key (suffix on output_path and source path)
riva-build --config-path=pkg://servicemaker.configs.asr --config-name=<streaming|offline> \
  output_path=/riva_build_deploy/custom_model.rmir:<encryption_key> \
  'source_path=[/riva_build_deploy/model.riva:<encryption_key>]'
```

**Starting from a `.nemo` checkpoint (inline `nemo2riva` config):**

```bash
# CTC family — verify the exact inline block on the pipeline-configuration page
riva-build --config-path=pkg://servicemaker.configs.asr --config-name=<streaming|offline> \
  output_path=/riva_build_deploy/custom_model.rmir \
  'source_path=[{path: /riva_build_deploy/model.nemo, nemo2riva: {format:onnx, onnx_opset:19, max_dim:1000}}]'

# RNNT family
riva-build --config-path=pkg://servicemaker.configs.asr --config-name=<streaming|offline> \
  output_path=/riva_build_deploy/custom_model.rmir \
  'source_path=[{path: /riva_build_deploy/model.nemo, nemo2riva: {format:nemo}}]'
```

The inline `nemo2riva` block is **per model family** — always look up the exact form for your architecture in the **Notes section** under each model's build command on the pipeline-configuration page.

> **Hybrid RNNT+CTC checkpoints** (e.g., Parakeet `trainable_v8.1`, model class `EncDecHybridRNNTCTCBPEModel`) cannot be exported by the default inline `nemo2riva: {format:onnx, ...}` block — it tries to export both the RNNT decoder/joint and CTC heads, and the RNNT export fails on these checkpoints. Convert the hybrid `.nemo` to a single-head (RNNT-only or CTC-only) `.nemo` first using NeMo's helper script:
> [`convert_nemo_asr_hybrid_to_ctc.py`](https://github.com/NVIDIA-NeMo/NeMo/blob/main/examples/asr/asr_hybrid_transducer_ctc/helpers/convert_nemo_asr_hybrid_to_ctc.py)
> Then pass the converted single-head `.nemo` to `riva-build` with the inline block matching that head's family (CTC or RNNT).

For the full parameter set and current per-config options, run `riva-build --config-path=pkg://servicemaker.configs.asr --config-name=streaming -h` (or `--config-name=offline -h`) inside the container.

For pipeline configuration options (streaming vs offline, VAD, language model, etc.), see [`pipelines.md`](pipelines.md).

---

## Phase 3 — Deploy Model Repository with `riva-deploy`

Still inside the container (or re-enter it), run `riva-deploy` to build the Triton model repository. Use `-f` so repeated builds replace stale generated files:

```bash
riva-deploy -f /riva_build_deploy/custom_model.rmir /data/models
```

**Important:** Always deploy to `/data/models` inside the container. Deploying elsewhere requires manual path fixes in Triton config files.

After deploy completes, create the tar archive:

```bash
cd /data/models
tar -czf /model_tar/custom_model.tar.gz *
```

Exit and remove the container:

```bash
exit
docker stop riva-build-deploy 2>/dev/null; docker rm riva-build-deploy 2>/dev/null
```

Your `custom_model.tar.gz` is now in `$NIM_EXPORT_PATH` on the host.

---

## Phase 4 — Launch the Custom NIM

```bash
docker run -it --rm --name=$CONTAINER_ID \
  --runtime=nvidia \
  --gpus '"device=0"' \
  --shm-size=8GB \
  -e NGC_API_KEY \
  -e NIM_TAGS_SELECTOR \
  -e NIM_DISABLE_MODEL_DOWNLOAD=true \
  -e NIM_HTTP_API_PORT=9000 \
  -e NIM_GRPC_API_PORT=50051 \
  -p 9000:9000 \
  -p 50051:50051 \
  -v $NIM_EXPORT_PATH:/opt/nim/export \
  -e NIM_EXPORT_PATH=/opt/nim/export \
  nvcr.io/nim/nvidia/$CONTAINER_ID:latest
```

> **Security note:** Environment variables passed via `-e` to Docker are visible in `docker inspect` output and process listings. For production, use Docker secrets or a secrets manager instead of passing credentials as env vars.

`NIM_DISABLE_MODEL_DOWNLOAD=true` prevents the container from downloading pre-trained models from NGC and uses the custom repository from `NIM_EXPORT_PATH` instead.

## Verify Readiness

```bash
curl -X GET http://localhost:9000/v1/health/ready
# Expected: {"status":"ready"}
```

## Run Inference on the Custom Model

```bash
python3 python-clients/scripts/asr/transcribe_file_offline.py \
  --server 0.0.0.0:50051 \
  --input-file /path/to/audio.wav \
  --language-code en-US
```

For runtime feature support (word boosting, force_eou, diarization, etc.) on your custom model, fetch the customization page — feature support depends on the underlying model architecture.

---

## Examples

**Build RMIR from a `.riva` artifact (inside NIM container):**

```bash
riva-build --config-path=pkg://servicemaker.configs.asr --config-name=streaming \
  output_path=/riva_build_deploy/model.rmir \
  'source_path=[/riva_build_deploy/model.riva]'
```

**Build RMIR from a `.nemo` checkpoint with inline `nemo2riva` config (CTC family — verify exact block on the pipeline-configuration page):**

```bash
riva-build --config-path=pkg://servicemaker.configs.asr --config-name=streaming \
  output_path=/riva_build_deploy/model.rmir \
  'source_path=[{path: /riva_build_deploy/model.nemo, nemo2riva: {format:onnx, onnx_opset:19, max_dim:1000}}]'
```

**Launch the custom NIM:**

```bash
docker run -it --rm --runtime=nvidia --gpus '"device=0"' \
  -e NGC_API_KEY -e NIM_DISABLE_MODEL_DOWNLOAD=true \
  -v $NIM_EXPORT_PATH:/opt/nim/export \
  -e NIM_EXPORT_PATH=/opt/nim/export \
  nvcr.io/nim/nvidia/$CONTAINER_ID:latest
```

**Lookup flow — agent question "which base container should I use for a fine-tuned Parakeet RNNT?":**

1. Fetch or open the support matrix
2. Locate the Parakeet RNNT family entry, copy its `CONTAINER_ID`
3. Use that as the base image in Phase 2

Do not pick a base image from this skill's text alone — the catalog rotates per release.

## Troubleshooting

- **Match container to model architecture** — use the NIM base image that matches your model family. Fetch the support matrix to find the right one.
- **Deploy to `/data/models` only** — other paths break Triton config references without manual edits.
- **`NIM_DISABLE_MODEL_DOWNLOAD=true` is required** — without it, the container ignores the custom model and downloads the default pre-trained model.
- **Encryption key consistency** — if the source `.riva` is encrypted, use the same `:<key>` suffix on `source_path`, the `.rmir` `output_path`, and `riva-deploy`.
- **Force rebuilds / redeploys** — `riva-build` rejects `-f` as unrecognized; pass `force=true` as a Hydra-style config parameter (`riva-build ... force=true ...`). `riva-deploy` accepts the `-f` CLI flag (`riva-deploy -f ...`).
- **Phase 3 runs on target GPU** — `riva-deploy` optimizes TensorRT engines for the deployment GPU; run it on the same GPU class you'll use in production.
- **`.nemo` architecture support** — not all NeMo architectures are supported by every NIM image, and the inline `nemo2riva` block is per model family. Check the **Notes section under each model** on the pipeline-configuration page for current architecture support and the exact inline-config keys.

## Limitations

- x86_64 architecture only — `riva-build` runs inside the NIM container
- NVIDIA AI Enterprise license required for self-hosting
- `.nemo` → RMIR conversion happens inside `riva-build` via the inline `nemo2riva` block; the set of supported NeMo architectures and the exact inline-config keys are version-locked per release — verify on the pipeline-configuration page (Notes sections) before converting
