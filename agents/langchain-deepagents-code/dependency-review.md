<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# LangChain Deep Agents Code Dependency Review

This file records the reviewed dependency baseline for the Deep Agents Code sandbox base image.
Update it whenever `requirements.lock` changes.

- Lockfile: `agents/langchain-deepagents-code/requirements.lock`
- Lockfile SHA-256: `229efec862ec10e6b128525e95c8fb8b44cdef8285a6cee78e3a7c73af780a9b`
- Audit command: `uvx --python 3.13 pip-audit -r agents/langchain-deepagents-code/requirements.lock --progress-spinner off`
- Audit date: 2026-07-03
- Audit result: `No known vulnerabilities found`

The Dockerfile installs this lockfile with `pip3 install --require-hashes`, so this review covers the exact package versions selected for the managed image install.

## Temporary Nemotron 3 Ultra Profile Backport

The image temporarily overlays the Nemotron 3 Ultra harness profile merged by
[langchain-ai/deepagents#4192](https://github.com/langchain-ai/deepagents/pull/4192)
because Deep Agents Code `0.1.30` pins the earlier `deepagents==0.7.0a3` release.

- Upstream PR head: `72fd0bba115df5ae35a549f58d3dd564f0bf0592`
- Upstream merge commit: `d5a60ece7379c37c81edcef2cd6c2811ddc90c9a`
- Vendored source SHA-256: `c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7`
- Local source SHA-256: `c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7`
- License: `agents/langchain-deepagents-code/LICENSE.langchain-deepagents` (MIT)

The vendored profile remains byte-for-byte identical to the merged upstream
source. The separate build patch adds only the two `openai:` aliases required
when NemoClaw passes its managed OpenAI-compatible `ChatOpenAI` instance.
Remove the source overlay and bootstrap registration when Deep Agents Code pins
a Deep Agents release containing the merge. Retain the alias bridge only until
the managed-model resolution tests pass without it. The patcher's exact DCode
and Deep Agents version gates make that dependency bump fail the image build
until this removal review is completed.
