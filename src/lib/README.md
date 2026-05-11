<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `src/lib` layout

`src/lib` is organized by architectural role first, then by product area. Use this map when adding new code or when moving legacy flat modules into clearer homes.

## Primary layers

```text
src/lib/commands/**  oclif adapter classes and parser glue
src/lib/actions/**   workflow orchestration and user-facing command behavior
src/lib/domain/**    pure decisions, policy, classification, and planning
src/lib/adapters/**  host boundaries: process, fs, Docker, OpenShell, HTTP
src/lib/state/**     persisted local state and state-file I/O
src/lib/cli/**       CLI framework, metadata, routing, and help infrastructure
src/lib/core/**      tiny cross-cutting primitives with minimal dependencies
```

Layering rules:

- Command classes should parse argv and call actions; they should not own product logic.
- Actions may compose domain helpers, adapters, state modules, and output.
- Domain helpers should stay pure and avoid direct process, filesystem, Docker, OpenShell, or network calls.
- Adapters isolate host-boundary calls so actions and tests can inject fakes.
- State modules own persisted local files and registry/session I/O.

## Transitional feature folders

Some older modules are still too large or coupled to split directly into actions/domain/adapters. Use these feature folders as intermediate homes while preserving behavior:

```text
src/lib/agent/**        agent definition, agent-specific onboarding, runtime helpers
src/lib/credentials/**  credential storage and credential command support
src/lib/dashboard/**    dashboard contract, health, and recovery helpers
src/lib/deploy/**       deploy/build-image support that is not yet action-shaped
src/lib/diagnostics/**  debug collection and diagnostic report helpers
src/lib/inference/**    inference config, health probes, local runtime helpers
src/lib/messaging/**    channel/messaging policy and message filtering helpers
src/lib/onboard/**      onboarding support modules around the large legacy flow
src/lib/policy/**       policy preset loading and application support
src/lib/runtime/**      sandbox/runtime recovery helpers
src/lib/sandbox/**      sandbox config, build, stream, and version support
src/lib/security/**     redaction, secret patterns, and credential filtering
src/lib/shields/**      shields orchestration, timers, and audit helpers
src/lib/tunnel/**       local service/tunnel command support
```

Prefer small mechanical PRs that move one cluster at a time. High-import legacy files such as `onboard.ts`, `runner.ts`, `policies.ts`, `nim.ts`, and `services.ts` should either move late or keep temporary compatibility re-export files at their old paths.

## Suggested migration sequence

1. Document the target map and conventions before moving more code.
2. Move low-risk feature clusters such as `agent`, `dashboard`, `diagnostics`, and `shields`.
3. Move security/credentials/core helpers.
4. Move inference/model/local-runtime helpers.
5. Move onboarding support files before considering the large `onboard.ts` flow.
