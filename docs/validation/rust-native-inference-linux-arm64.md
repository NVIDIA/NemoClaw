<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native Inference and Sandbox Harness Validation

Recorded on 2026-09-16 on Linux ARM64 with Docker 29.2.1.
The schema and deterministic fixtures pass; live inference through the pinned OpenShell revision remains blocked by main-process environment propagation.
This record does not qualify the native inference migration for live deployment.

## Revisions and Artifacts

| Component | Tested identity |
|---|---|
| NemoClaw final fixture source | `8e5215324aac365cb924c99c75383141f0c8a682` |
| Final native bundle | `0.1.0-dev.8ed145050d35a19c`, Rust 1.98.1, OpenTofu 1.12.6 |
| Live-attempt source and bundle | `c8dde61d4f`, `0.1.0-dev.84c55c3b774b423a` |
| OpenShell source | `b3e4ad4579e24dacfb285924876473b50a04b988`, gateway version `0.0.117-dev.155+gb3e4ad457` |
| Gateway image | `ghcr.io/nvidia/openshell/gateway@sha256:37a5e3b1d55de018d02aa842239eb191dafa27617788977b07b0c5b495f7a11a` |
| Sandbox runtime image | `ghcr.io/nvidia/openshell/sandbox@sha256:854dcef3a4354780422dd4bc0e8b38bbd301974815c9b028ef1bb7c20ebc9868` |
| Supervisor image | `ghcr.io/nvidia/openshell/supervisor@sha256:5787e5bad644cdaf064d6a40a1671942d72cec4b27e31422ec0e7466fc3c794d` |
| Fabric source | `6e155bfbe9e740fb8ce1e1fda900d96f1435a23c` |
| OpenClaw image | `nc-multi-models@sha256:3ab70ded67440e838a37d6c9f0e3b08b95e2acf416c6076f8817bac190525cf0` |
| Pi image | `nc-multi-models@sha256:2ee5e33522a37d3d77bb6381a92e963cb1d5884f2dd28b353b4b7fa0d95f212e` |

The live document explicitly selected the rebuilt OpenClaw image above.
The final source promotes that image to the default; the harness ownership and live-launch implementation are unchanged from the live-attempt source.
Images were built locally and were not published.

## Deterministic Checks

Workspace tests, formatting, Clippy with warnings denied, and generated schema/documentation checks passed.
The Python suite ran 49 tests: 43 passed and six were explicitly skipped.
The TypeScript inference probe passed local protocol tests for all three supported APIs, duplicate choices, a failed secondary choice, and missing credentials; type checking, linting, and formatting passed.
The actual packaged probe also ran against a local fixture inside its image with Docker networking disabled.

Schema tests cover exactly one sandbox `harness` or `harnessRef`, rejected agent-level selection, shared definitions at both supported scopes, shadowing, unused definitions, preserved export form, and harness-specific agent limits.
Compiled multi-model settings are validated against the strict Fabric OpenClaw adapter descriptor.

The final bundle passed all 28 lifecycle fixtures: 16 deployment, 11 Fabric, and one multiple-provider test, using two test threads as in CI.
Use the [fixture procedure](../testing/fixtures.md#opentofu-and-bundle-lifecycle) to reproduce the run.
The multiple-provider fixture covers two independent deployments, selected provider unions, unused definitions, export/reapply, unchanged state, scoped provider drift, independent destroy, removed profiles, and retained workspaces.
These fixtures use a local gRPC server and actual OpenTofu/provider execution; they do not establish live inference.

Native Pi protocol fixtures passed with custom model metadata and with a catalog model.
They verified request model IDs, ordered invocations, unchanged configuration, model updates, and shutdown against local TLS fixtures, without a live provider.

## Live Attempt and Blocker

An independently running CPU-only Ollama container served `qwen2.5:0.5b` and `qwen2.5:1.5b` at a private Docker-bridge endpoint.
Its image was `ollama/ollama@sha256:684d8674b4315fa18f4f0e973a118ec2652ed96f67563277839985175858e0ba`.
A direct request to the smaller model returned “The word is four.”
That response verifies the external test service only.
The server was started before apply and remained running after the failed deployment was destroyed.

The document selected one shared OpenClaw harness on the sandbox, two native providers, and two agents: researcher with fast/smart choices and writer with fast only.
The managed gateway, owned profiles/providers, sandbox container, and separate supervisor started.
Apply failed sandbox readiness and retained the established identities.
No successful model request through OpenShell or native agent reply was established.

A disposable diagnostic sandbox copied the same launch specification and enabled OpenShell's main-process attachment to capture its terminal output.
The main process failed before Fabric initialization:

```text
KeyError: 'NEMOCLAW_AGENT_NAME'
```

At the pinned revision, `openshell-sandbox/src/process.rs` reads the declared user environment but uses it only to decide whether to supply HOME/USER/SHELL/TERM defaults; it does not apply the declared values to the canonical process command.
The Docker boundary passes those values separately rather than inheriting them as process environment.
A local upstream regression test reproduced the missing custom variable and HOME value.
A candidate fix applies the declared map before stripping supervisor-only keys and injecting provider placeholders.
The regression passed, including protected-key removal and provider-placeholder precedence, and the sandbox library suite passed 201 tests with one explicit skip.
That candidate is not part of the pinned upstream revision or the images above, and has not been qualified end to end.

All owned test workloads, diagnostic sandboxes, gateways, and the independent Ollama container were removed.
Owned gateway storage/workspace bindings and downloaded test models were retained.
The pre-existing deployment was left running.

## Remaining Gates

Live acceptance still requires a corrected, immutable OpenShell runtime and a fresh deployment that verifies every configured model, native default and explicit model selection, denied unselected choices, unchanged apply, export/reapply, and teardown.
Authenticated hosted-provider injection, live separate-sandbox isolation, and other harnesses' live native connections remain unqualified.
Per-agent model policies inside one sandbox are not separate credential or network boundaries.
