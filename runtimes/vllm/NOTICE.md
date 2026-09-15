<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Generic vLLM Runtime

This artifact adds the NemoClaw runtime supervisor to the immutable upstream vLLM image named in its Dockerfile.
It does not apply the Qwen3.8 recipe patches or embed model weights.
The selected model is downloaded into retained storage when the deployment is applied.

`supervisor-source.tar.gz` retains the supervisor's source and locked dependency sources, including their original license files.
The archive excludes every `runtimes/` directory; it contains no Qwen recipe scripts or recipe license files.
The SDK policy credit remains in `crates/nemoclaw-sdk/NOTICE.md` inside the archive.
`/opt/nemoclaw/source/Dockerfile` and `build.json` retain this image's build instructions and manifest.
`supervisor.json` records the source archive and executable hashes.
The upstream image retains its vLLM and installed dependency notices.
Model license and notice files present at the selected repository root are downloaded with the model snapshot.
