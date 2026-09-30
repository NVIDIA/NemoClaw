<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Model Cache Qualification

On 2026-09-29, the cache checks passed on Linux ARM64 with Docker 29.2.1.
The source was `e5cb9082c63b5d5e7f9ba6e87327b9b781ff556c` plus the cache tests and Ollama image update accompanying this record.
[Fixture instructions](../testing/fixtures.md#model-cache-compatibility) reproduce the checks using temporary files and owned disposable containers.

## Ollama

The new [cache test](../../crates/nemoclaw-runtime/tests/ollama_cache.rs) first failed because the previous runtime image reported 0.17.7 while `versions.json` declared 0.34.0.
The previous image was `ollama/ollama@sha256:0ff452f6a4c3c5bb4ab063a1db190b261d5834741a519189ed5301d50e4434d1`.
Its cache inventory checks passed before the version assertion failed.

The runtime now uses `ollama/ollama@sha256:684d8674b4315fa18f4f0e973a118ec2652ed96f67563277839985175858e0ba`, whose ARM64 manifest is `sha256:8a39a0a3ef5a08cd7206fe2d2ffbbc3d7aee9d7b22e0e2098d17c4bdf1b0b7e9`.
The test passed against that exact image in 0.93 seconds:

- NemoClaw verified and committed complete synthetic partial files into its native Ollama cache paths.
- A second installation preserved the verified snapshot without downloads.
- Real Ollama `/api/tags` returned the authored name, full manifest SHA-256, and combined config/blob size; a missing model remained absent.
- Ollama read the cache through a read-only mount, and NemoClaw's retained verification metadata remained valid.
- `/api/version` reported 0.34.0, matching the declared dependency.

The [0.34.0 pull API](https://github.com/ollama/ollama/blob/d8ab4b4f0ca24b51d3a46b3bf4f462e58ce66b1f/server/images.go) still selects a tag without accepting an expected manifest digest.
NemoClaw therefore retains its digest-checked downloader and qualifies the private layout against the pinned runtime image.
The image's license source now matches that revision; its MIT license bytes and SHA-256 were unchanged.

## Hugging Face

The pinned vLLM image `vllm/vllm-openai@sha256:3b0e188ffceb3d07e09c3cb5215433a0020eacf02d7f882ed3a8bfd15454477e` contains `huggingface_hub` 1.28.0 on ARM64.
The [download check](../../runtimes/vllm/test_download.py) passed inside that image with external networking disabled.
It called the installed client's HTTP downloader against a loopback fixture with an expected size of 4 bytes.
The client wrote all 7,168 response bytes before raising its size error.
Verification after that download cannot preserve NemoClaw's write bound, so this client does not replace the retained downloader.

## Limits

These checks downloaded no model, exposed no GPU, and made no generation or model-load request.
The synthetic blob is not a usable model.
The Ollama result qualifies cache layout and inventory compatibility on the named ARM64 image, not GPU loading, inference, other architectures, or custom images.
The Hugging Face result covers its HTTP download path; it does not qualify other transfer backends.
Both Ollama fixture containers were removed after their runs, including the failing run.
