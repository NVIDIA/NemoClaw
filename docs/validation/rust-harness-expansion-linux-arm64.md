<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Harness and Provider Expansion Validation

Recorded on 2026-09-17 on a Linux ARM64 DGX Spark, through NemoClaw commit `c32f92c368`.
The passing cases used real OpenShell gateways, sandboxes, native harnesses, OpenTofu, and the production provider.
Some cases used controlled inference or search servers, as identified below; those cases do not qualify a public provider service.

OpenShell was pinned to `7e7a8d5610f336f5f7f9f60da0951adbf295475d` and Fabric to `6e155bfbe9e740fb8ce1e1fda900d96f1435a23c`.
Agent images were rebuilt locally for the feature under test and selected by immutable digest; no images were published.
Each passing case included plan, apply, the native behavior check, unchanged plan/apply, export/reapply, and destroy.
Test workloads were removed; owned retained storage and networks were preserved.
Existing deployments and their inference services were left running.

## Passing Cases

| Feature and implementation commit | Observed behavior | Qualification limit |
|---|---|---|
| Execution settings, `16018f27bb` | Deep Agents used the configured 45-second Fabric timeout and 128-token output limit and answered through real Qwen3-4B inference. | Other harness timeout mappings and supported output limits have deterministic coverage; this live case does not qualify every tuning setting. |
| Search credentials, `0e127c7e60` | Two OpenClaw sandboxes used distinct credential references and provider registrations; the native search plugin passed an in-sandbox HTTP fixture test. | The plugin fixture used its own test key. Public Brave credential rewriting, subscriptions, and quotas were not tested. |
| Multiple managed services, `df8e1704ea` | Two independently owned, authenticated vLLM Qwen3-4B services powered separate Deep Agents sandboxes; both answered. | One Linux ARM64 host; managed Ollama and its proxy retain a singleton lifecycle. |
| Pi choices, `a1513e9711` | One Pi session selected both declared route aliases and obtained real Qwen3-4B replies; unchanged apply preserved the hosted runtime ID. | Both aliases selected the same Qwen model. Distinct model IDs, unknown-choice rejection, and conversation preservation have deterministic coverage. |
| Native tool policy, `a25e09791a` | Controlled model responses made Deep Agents and Pi read a marker file; attempted writes were blocked and the target file remained absent. | This qualifies the supported `read` policy, not arbitrary tool vocabularies. |
| Deep Agents search, `060a289afe` | Controlled inference drove native Deep Agents through an MCP fixture wrapper around the production search function; the local HTTP fixture’s marker reached the tool transcript. | Real-model tool selection, public Brave credential rewriting, and the public service were not tested. |
| Deep Agents roster, `40d0ba2d5e` | Two agents in one sandbox had distinct model, tool, integration, workspace, and artifact settings; both answered, with separate health groups. One used real Qwen3-4B and one used controlled inference. | Per-agent directories and tool settings are not separate sandbox security boundaries. Each Deep Agents instance still selects one model. |
| Hermes interfaces and Relay, `c32f92c368` | Native API and dashboard started together with Relay; an API invocation returned the controlled response and produced ATOF events. Graceful API shutdown finalized a parseable ATIF trajectory. | The attempted real Qwen endpoint advertised 32K context, below Hermes’s 64K requirement. The successful case used controlled inference. |
| Ollama proxy expansion, `be23cd0e7b` | Deep Agents and Pi answered through the managed proxy and a real external CPU Ollama `qwen3:0.6b` model. Destroy retained the external daemon and model. | Pi declared compatible custom model metadata. This does not qualify every harness or Ollama model. |

The owned external Ollama test container was removed separately after verifying the deployment did not remove it.
The operator-owned model volume was retained.

## Managed Podman Remains Blocked

The local managed-Podman implementation was not pushed to `origin/v1` because its native inference test failed.
Its rootless Podman 5.8.7 lifecycle passed plan/apply, unchanged operations, export/reapply, and destroy using the pinned OpenShell images.
Agent startup and lifecycle success did not establish working inference.

The Podman supervisor runs without permission to create the default `/etc/openshell-tls` directory.
Unlike the Docker and Kubernetes drivers, the pinned Podman driver does not set `OPENSHELL_PROXY_TLS_DIR=/run/openshell/proxy-tls`.
The supervisor logged `Failed to write CA files, TLS termination disabled: Permission denied` and then refused provider traffic because credential rewriting was unavailable.
OpenShell main at `7d5b2e4fb0621f78dab6685f609d9f8cc6026207` had the same omission when inspected.
No custom supervisor image or relaxed egress policy was used to bypass this failure.

Managed Podman needs an upstream correction and a fresh successful agent-inference lifecycle before qualification.
Earlier [external Podman evidence](rust-podman-rootless-linux-arm64.json) remains specific to its recorded revision and does not establish support on the current pin.

## Automated Validation and Build Time

Behavioral regression tests were observed failing before implementation; focused tests, formatting, strict workspace Clippy, and the workspace suite passed for the feature commits.
Changed Python/TypeScript image checks and documentation checks also passed.
Manual live tests remain outside the normal CI matrix.

The development profile uses reduced debug information, and dependency cache keys include the root Cargo manifest so profile changes invalidate the cache.
Release settings are unchanged.
[The final feature CI run](https://github.com/NVIDIA/NemoClaw/actions/runs/35219096351) passed all four jobs: Windows 10m31s, Linux ARM64 7m20s, Linux AMD64 7m04s, and macOS ARM64 6m55s.
These are observed job durations with warm caches, not guarantees for cold builds or queued runs.
