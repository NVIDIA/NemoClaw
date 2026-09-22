<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hosted OpenClaw Fixture Provenance

`v0.yaml` retains the representative source manifest from NVIDIA/NemoClaw revision `f47724f29838fe08898993fad1c8c6b7fcb3e080`.
Its SHA-256 is asserted by the deterministic test.

`v0-export.yaml` is raw, credential-value-free output from the public `nemoclaw config export` contract delivered by NVIDIA/NemoClaw revision `b6934c6300c4e1e175757e9281ae3a641d9a5b1f` for issue #11977.
On 2026-09-17, it replaced the synthetic legacy export used by #11813.
The YAML retains the credential environment-variable reference and contains no credential value.

`v1.yaml` records the same portable intent explicitly reauthored on 2026-09-17 for the required singular `agent` field.
The historical raw export retains its `agents` list and is rejected by the current parser.
The deterministic test compares the authored fixture with a test-only projection of the historical data; the SDK supplies no compatibility translator.

Live verification likewise requires a separate `NEMOCLAW_LIVE_V1_CONFIG` artifact alongside the unchanged `NEMOCLAW_LIVE_V0_EXPORT`.
It compares intent before deployment and records each artifact’s hash and redacted bytes; only the explicitly authored current configuration drives the v1 lifecycle.
