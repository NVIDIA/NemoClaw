<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fixtures

Reusable scenario fixtures that start/stop test doubles or prepare
preconditions shared across multiple suites.

## Planned fixtures (from UAT/NV QA hotspot analysis)

| Fixture | First consumer | Purpose |
|---|---|---|
| `fake-openai.sh` | `inference/cloud/` fast-mode variant | Start/stop a local OpenAI-compatible endpoint so inference assertions can run on PR CI without hitting real NVIDIA endpoints. Targets the 12 real-cloud tests that today flake on `integrate.api.nvidia.com` latency (UAT #2600). |
| `fake-telegram.sh` | `messaging/providers/` | Local Telegram API stub. Removes dependency on real `api.telegram.org` in CI. |
| `older-base-image.sh` | `sandbox/rebuild-openclaw/`, `sandbox/rebuild-hermes/`, `sandbox/upgrade-stale/` | Pull an older base image tag from ghcr + build a temporary Dockerfile that pins the prior OpenClaw version. Dedupes the three hand-rolled implementations the original E2E tests share. |

## Contract

Each fixture must expose:

- `fixture_<name>_up`   — start; block until ready; export required env vars.
- `fixture_<name>_down` — stop; idempotent; safe from trap.

Failure in `_up` must be fatal; failure in `_down` must log and continue.
