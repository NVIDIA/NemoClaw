<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native NIM image

This image adds the NemoClaw supervisor and writable data directories to NVIDIA NIM for LLMs 2.0.12, using `nvcr.io/nim/meta/llama-3.1-8b-instruct` at the index digest in the Dockerfile. Native launch scripts, nginx, model/profile handling, and upstream notices remain in the base image.

NemoClaw runs the native vLLM backend and preserves its authentication implementation. A separate container runs the image's nginx with an inference route allowlist. Docker bridges isolate native management listeners from gateway peers.

The Apache license applies to NemoClaw's additions. NIM, its dependencies, and model weights retain their own licenses and terms. Model downloads require an entitled NGC credential. Building this target does not grant model access or distribution rights.
