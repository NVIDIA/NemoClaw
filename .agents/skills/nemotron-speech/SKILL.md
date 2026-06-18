---
name: "nemotron-speech"
description: Routes NVIDIA Nemotron Speech (Riva) NIM tasks — deploys, runs, and tests ASR, TTS, and NMT NIMs on build.nvidia.com or self-hosted.
triggers:
  - Nemotron Speech
  - deploy Riva NIM
  - deploy ASR/TTS/NMT NIM
  - Riva ASR
  - Riva TTS
  - Riva translation
  - Parakeet
  - Canary
  - Whisper
  - Nemotron ASR Streaming
  - Magpie TTS
  - DNT tag
  - nemo2riva
  - riva-build
  - riva-deploy
  - RMIR
  - Riva NIM setup
  - NGC API key
  - force_eou
  - Silero VAD
  - Sortformer diarization
  - chunk size Riva
  - Riva HTTP
  - Riva WebSocket
  - grpc.nvcf.nvidia.com
  - build.nvidia.com Riva
version: "1.0.0"
license: Apache-2.0
metadata:
  author: "Nemotron Speech Team"
  team: riva
  tags:
    - nvidia
    - nemotron-speech
    - riva
    - nim
    - asr
    - tts
    - nmt
    - speech
    - speech-to-text
    - text-to-speech
    - translation
    - parakeet
    - canary
    - whisper
    - magpie
    - nemotron
    - grpc
    - http
    - websocket
    - cloud
    - nvcf
  domain: ml
---

# Nemotron Speech Skills

> **Note:** "Nemotron Speech" is the public-facing name for what NVIDIA documents today as **Riva** / **Riva NIM**. All commands, container images, gRPC APIs, Python imports, and documentation URLs still use **"Riva"** — the rename is brand-only. Do not rename commands, images, or doc URLs.
>
> **Agent:** When walking the user through a multi-step workflow, announce each step before presenting it: **Step N/M — Step Title** (e.g., "**Step 1/4 — Deploy the Container**").

## Purpose

Single entry point for all NVIDIA Nemotron Speech (Riva) NIM workflows: ASR (speech-to-text), TTS (text-to-speech), and NMT (translation). Covers cloud-hosted inference via build.nvidia.com, self-hosted Docker deployment, client-protocol choice for ASR (gRPC, HTTP, WebSocket), custom NeMo model deployment via `riva-build`, ASR pipeline tuning (VAD, diarization, language models), and the prerequisite Docker / NGC / driver setup.

## When to Use This Skill

Use this skill for any Nemotron Speech / Riva NIM task — deployment, testing, custom model build, system requirements check, or model selection across ASR / TTS / NMT modalities.

## Workflow

Identify the user's task type, then load the corresponding reference file from `references/`. The reference files contain the detailed per-workflow content; this SKILL.md is a routing surface. Load only the reference relevant to the task at hand.

## Prerequisites

- For **self-hosted deployment**: NVIDIA AI Enterprise (NVAIE) entitlement, then complete the environment setup — NVIDIA drivers, Docker, Container Toolkit, NGC API key, Riva Python client. See [`references/setup.md`](references/setup.md).
- For **cloud-hosted inference**: `pip install -U nvidia-riva-client` and a valid `NVIDIA_API_KEY` from https://build.nvidia.com.
- Treat `NVIDIA_API_KEY` and `NGC_API_KEY` as secrets: never print, paste, commit, or log real key values. Prefer `--password-stdin` for Docker login and store persistent keys in a credential manager or a `chmod 600` env file rather than world-readable shell startup files.
- For **self-hosted Docker model caching**: host directories mounted at `/opt/nim/.cache` must be writable by the container user (the NIM container runs as `nvs:1000` internally), not just the host user. Run `sudo chown 1000:1000 $LOCAL_NIM_CACHE` after creating the directory so the container can write to it. Avoid world-writable modes — they let any local user replace cached model artifacts. Also avoid `-u "$(id -u):$(id -g)"` on the docker run — `/opt/nim/workspace` inside the container isn't writable to arbitrary UIDs. If you see `I/O error Permission denied (os error 13)` during model download, the host directory ownership is the issue.

## Instructions

- Match the user's task to one reference file and load only that file; the references are detailed, so progressive disclosure keeps context tight.
- Route setup requests for drivers, Docker, Container Toolkit, and NGC to [`references/setup.md`](references/setup.md).
- Route GPU compatibility, deployment readiness, and container health checks to [`references/deployment-readiness-checks.md`](references/deployment-readiness-checks.md).
- Route model choice across ASR, TTS, and NMT to [`references/model-selection.md`](references/model-selection.md).
- Route ASR deployment or inference for Parakeet, Canary, Whisper, and Nemotron ASR Streaming to [`references/asr.md`](references/asr.md).
- Route custom-trained NeMo ASR deployment (`.nemo` → RMIR → NIM) to [`references/asr-custom.md`](references/asr-custom.md).
- Route ASR pipeline configuration for VAD, diarization, language models, and chunk size to [`references/pipelines.md`](references/pipelines.md).
- Route TTS deployment or inference for Magpie to [`references/tts.md`](references/tts.md).
- Route NMT deployment or inference for Riva Translate, language pairs, and DNT tags to [`references/nmt.md`](references/nmt.md).

## Source of truth

For per-release detail — current model catalog, container IDs, function IDs, voice lists, VRAM minimums, per-model feature support — **fetch or open the canonical NVIDIA doc** rather than relying on text in this SKILL.md or the references. Each reference file includes its own routing table to the relevant doc pages.

Top-level landing pages:

| Topic | URL |
|---|---|
| ASR support matrix | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html |
| TTS support matrix | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/tts.html |
| NMT support matrix | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/nmt.html |
| Prerequisites (driver / GPU / OS) | https://docs.nvidia.com/nim/speech/latest/get-started/prerequisites.html |
| ASR pipeline configuration | https://docs.nvidia.com/nim/speech/latest/asr/customization/pipeline-configuration.html |
| ASR runtime customization | https://docs.nvidia.com/nim/speech/latest/asr/customization/customization.html |
| Cloud function IDs (per model) | `https://build.nvidia.com/<org>/<model>/api` |
| NGC catalog | https://catalog.ngc.nvidia.com/orgs/nim/teams/nvidia/models |

## Examples

**"Deploy a Parakeet ASR NIM"** → load [`references/asr.md`](references/asr.md), follow Option B (self-hosted), Steps 1–4.

**"Synthesize speech with Magpie"** → load [`references/tts.md`](references/tts.md), follow Option A (cloud) or Option B (self-hosted).

**"Translate English to German"** → load [`references/nmt.md`](references/nmt.md), follow the 4-step flow.

**"Convert my fine-tuned `.nemo` to a NIM"** → load [`references/asr-custom.md`](references/asr-custom.md) for the 4-phase pipeline and [`references/pipelines.md`](references/pipelines.md) for build-time config.

**"Can my GPU run this?"** → load [`references/deployment-readiness-checks.md`](references/deployment-readiness-checks.md) and run the 6-step system check.

**"Which Riva model should I use?"** → load [`references/model-selection.md`](references/model-selection.md), apply the decision framework, then fetch the support matrix for the specific current model name.

## Naming & Terminology

- **Skill brand**: Nemotron Speech (public-facing name).
- **Internal naming preserved**: commands (`riva-build`, `riva-deploy`, `riva_streaming_asr_client`), Python client (`riva.client`), gRPC namespace (`nvidia.riva.asr.*`), container registry (`nvcr.io/nim/nvidia/*`), and all NVIDIA documentation URLs still use **"Riva"**. Do not rename these in code, commands, or docs.

## Troubleshooting

For task-specific runtime or modality issues, use the relevant reference file (`references/<task>.md`). Cross-cutting readiness checks:

- **Container does not become ready** → [`references/deployment-readiness-checks.md`](references/deployment-readiness-checks.md) (system check + health check table)
- **Health check fails** → [`references/deployment-readiness-checks.md`](references/deployment-readiness-checks.md)
- **`docker pull` from `nvcr.io` returns 403** → [`references/setup.md`](references/setup.md) (Step 5 — Docker login)
- **Wrong base image / model architecture mismatch** → [`references/asr-custom.md`](references/asr-custom.md) (Phase 2 base image)
- **VRAM / GPU compatibility** → [`references/deployment-readiness-checks.md`](references/deployment-readiness-checks.md), then verify on the support matrix

## Limitations

- x86_64 architecture only — WSL2 on Windows requires Podman and supports a subset of NIMs (see [`references/setup.md`](references/setup.md))
- Self-hosted deployment requires an NVIDIA AI Enterprise license
- Cloud-hosted inference requires an active `NVIDIA_API_KEY` and internet access
- Public skill branding is **"Nemotron Speech"**; commands, container images, Python imports (`riva.client`), gRPC services (`nvidia.riva.*`), and NVIDIA documentation URLs still use **"Riva"** — follow official docs and catalogs for naming, do not rename these in commands or code

## Next Steps

- Verify hardware compatibility: [`references/deployment-readiness-checks.md`](references/deployment-readiness-checks.md)
- Set up the environment: [`references/setup.md`](references/setup.md)
- Pick a model: [`references/model-selection.md`](references/model-selection.md)
- Deploy: [`references/asr.md`](references/asr.md), [`references/tts.md`](references/tts.md), or [`references/nmt.md`](references/nmt.md)
