<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Current Config Export Fixture Provenance

`openclaw.yaml` and `hermes.yaml` are raw deterministic outputs from the repaired v0 producer for #12131.
`network-policy-live.yaml` is the raw installed-CLI output retained by
[E2E run 35597079087](https://github.com/NVIDIA/NemoClaw/actions/runs/35597079087) for the
restricted OpenClaw `network-policy` target.
The deterministic fixture producer revision is `0a361a239c18dd4a56c34b4ca66dc32a3139bddd`.
The live fixture producer revision is `11d14209469f4ea1629e603f65c9a9bb1602339b`.
The target v1 parser revision is `9d446d51803ea6e3c6aaa286cee57c611173f214`.
All three revisions are recorded by the parser test.
The fixtures preserve the OpenClaw route and policy mapping and the Hermes API-key authentication mapping.
Their SHA-256 hashes are asserted before the current v1 parser consumes the unchanged bytes.
