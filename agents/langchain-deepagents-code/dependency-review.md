<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# LangChain Deep Agents Code Dependency Review

This file records the reviewed dependency baseline for the Deep Agents Code sandbox base image.
Update it whenever `requirements.lock` changes.

- Lockfile: `agents/langchain-deepagents-code/requirements.lock`
- Lockfile SHA-256: `47ebb552378f5071db027659d39c3de94785bd52a75a77b59fd63f844aa44794`
- Audit command: `uvx --python 3.13 pip-audit -r agents/langchain-deepagents-code/requirements.lock --progress-spinner off`
- Audit date: 2026-07-02
- Audit result: `No known vulnerabilities found`

The Dockerfile installs this lockfile with `pip3 install --require-hashes`, so this review covers the exact package versions selected for the managed image install.
