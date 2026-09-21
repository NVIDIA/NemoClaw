<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Current Config Export Fixture Provenance

`openclaw.yaml` and `hermes.yaml` are raw outputs from the repaired v0 producer for #12131.
The producer revision is `0a361a239c18dd4a56c34b4ca66dc32a3139bddd`.
The target v1 parser revision is `9d446d51803ea6e3c6aaa286cee57c611173f214`.
Both revisions are recorded by the parser test.
The fixtures preserve the OpenClaw route and policy mapping and the Hermes API-key authentication mapping.
Their SHA-256 hashes are asserted before the current v1 parser consumes the unchanged bytes.
