<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# LangChain Deep Agents Code Dependency Review

This file records the reviewed dependency baseline for the Deep Agents Code sandbox base image.
Update it whenever `requirements.lock` changes.

- Lockfile: `agents/langchain-deepagents-code/requirements.lock`
- Lockfile SHA-256: `a0b986369ff564ed9105c4e95915541ccc161d6f1e8032cc496127ea3e7d2e45`
- Audit command: `pip-audit -r agents/langchain-deepagents-code/requirements.lock --progress-spinner off`
- Audit date: 2026-06-22
- Audit result: `No known vulnerabilities found`

The Dockerfile installs this lockfile with `pip3 install --require-hashes`, so this review covers the exact package versions selected for the managed image install.
