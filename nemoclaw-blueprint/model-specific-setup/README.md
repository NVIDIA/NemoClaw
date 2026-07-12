<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Model-Specific Setup Registry

This registry is the ownership boundary for model/provider compatibility work that has to differ by agent runtime. Every manifest declares exactly one `agent` and lives under the matching directory:

- `model-specific-setup/openclaw/` for OpenClaw compatibility.
- `model-specific-setup/hermes/` for Hermes compatibility.

Do not add shared multi-agent manifests in v1. OpenClaw and Hermes have different config files, plugin systems, replay behavior, and E2E paths, so a fix should be proven and reviewed for one agent at a time.

## Manifest Shape

Manifests follow `schema.json`:

- `id`: stable registry id.
- `agent`: exact agent id, for example `openclaw` or `hermes`.
- `description`: human-readable reason for the setup.
- `match`: model/provider route predicates.
- `effects`: declarative, agent-scoped effects.

The first OpenClaw entry is `openclaw/kimi-k2.6-managed-inference.json`. It preserves the Kimi K2.6 managed `inference.local` compatibility behavior from PR #3046.

## Contributor Guidance

Put model-specific sandbox compatibility here, not directly in generator conditionals:

- Match logic belongs in a manifest.
- OpenClaw executable wrappers belong under `nemoclaw-blueprint/openclaw-plugins/`.
- Hermes executable wrappers belong under `agents/hermes/`.
- Runtime transformations stay in agent-owned code or plugins; registry manifests stay declarative.

Only add Hermes-specific Kimi behavior after a Hermes-specific failure or acceptance test proves it is needed.
