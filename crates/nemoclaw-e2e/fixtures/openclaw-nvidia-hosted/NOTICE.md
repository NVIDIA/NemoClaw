<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hosted OpenClaw Fixture Provenance

`v0-export.yaml` is raw, credential-value-free output from the public `nemoclaw config export` contract delivered by NVIDIA/NemoClaw revision `b6934c6300c4e1e175757e9281ae3a641d9a5b1f` for issue #11977.
On 2026-09-17, it replaced the synthetic legacy export used by #11813.
The YAML retains the credential environment-variable reference and contains no credential value.

`../../cases/docker-openclaw-v0-parity.yaml` records the same portable intent explicitly reauthored on 2026-09-17 for the required singular `agent` field, and on 2026-10-22 for inference providers and sandboxes keyed by name.
The historical raw export retains its `agents` list and its lists of named inference providers and sandboxes.
The deterministic test compares the authored case with a test-only projection of the historical data; the SDK supplies no compatibility translator.

The live lifecycle deploys only the authored case, through `hcl/tests/docker-openclaw-v0-parity.tftest.hcl`; the raw export is never deployed.
