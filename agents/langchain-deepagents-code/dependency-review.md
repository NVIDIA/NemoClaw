<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# LangChain Deep Agents Code Dependency Review

This file records the reviewed dependency baseline for the Deep Agents Code sandbox base image.
Update it whenever `requirements.lock` changes.

- Lockfile: `agents/langchain-deepagents-code/requirements.lock`
- Lockfile SHA-256: `1de9c299ad61bd11edfc0c72e7b99f9c60cbed233909cfdf166263f6337ffa07`
- Audit command: `uvx --python 3.13 pip-audit -r agents/langchain-deepagents-code/requirements.lock --progress-spinner off --disable-pip`
- Audit date: 2026-07-07
- Audit result: `No known vulnerabilities found`

The Dockerfile installs this lockfile with `pip3 install --require-hashes`, so this review covers the exact package versions selected for the managed image install.

## Released Nemotron 3 Ultra Profile

Deep Agents Code `0.1.34` pins `deepagents==0.7.0a6`, whose official wheel
contains the Nemotron 3 Ultra harness profile merged in Deep Agents PR #4192.
NemoClaw no longer vendors or overlays that source.

- Native profile SHA-256: `c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7`
- Unmodified built-in bootstrap SHA-256: `005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf`
- Managed-alias bootstrap SHA-256: `9d9e817143b330fd45345fcfa8276ea6fe5d6bc5a396f0438b0899a450e4744b`

The build patch verifies those official artifacts, then registers the native
profile under the two `openai:` model keys used by NemoClaw's managed
OpenAI-compatible `ChatOpenAI` route. It is atomic, idempotent, and fails closed
on version, source, bootstrap, or partial-state drift. The image build applies
the patch and runs the complete profile and dispatch validator against the
installed hash-locked wheels, while focused fixtures cover failure states.

Deep Agents Code `0.1.34` is the released consumer; prerelease risk is limited
to its exact `deepagents==0.7.0a6` SDK pin. That risk is accepted because the
consumer and SDK are hash locked, the dependency audit is clean, and all source,
version, middleware, graph, and dispatch checks fail closed.

The exact version and source-hash gates are also the lifecycle tracker for the
alias bridge: any dependency change stops the image build and requires this
review to be updated. No standalone removal issue is used for this bridge. When
Deep Agents natively recognizes both managed keys, that mandatory dependency
review removes the bridge instead of updating its hashes.
