<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Example Onboarding TUI

This crate provides the terminal questionnaire used by `nemoclaw onboard` and the standalone example.
It is a trial authoring flow over `nemoclaw-authoring`.
It writes validated YAML and can read target observations through a verified native bundle.
It reports credential-reference availability without retaining values, and does not create deployment state or apply resources.

With the [build prerequisites](../../docs/build.md) available, run from the repository root in a terminal:

```sh
cargo run -p nemoclaw-cli -- onboard examples/onboarding/openclaw.yaml --output my-deployment.yaml
```

A built CLI accepts the same arguments:

```sh
nemoclaw onboard examples/onboarding/openclaw.yaml --output my-deployment.yaml
```

Omit the template to use the built-in defaults.
The template's choices are preselected; Enter accepts an answer.
The questionnaire chooses an unresolved question whose dependencies are resolved, preferring questions that constrain more remaining choices.
It skips inactive fields and choices with only one supported answer.
You can go back to change an answer.
If a change affects answers you already accepted, the questionnaire shows them before making the change.
Accept the revision to revisit affected questions, or go back to keep the current configuration.
Unrelated accepted answers are preserved and skipped when continuing forward.

After accepting a harness, press **Ctrl+D** on an answer screen to authorize the remaining suggested settings and go directly to review.
The authoring library checks the suggestions together: engine and image compatibility must be established, the matching endpoint must advertise the selected model, and required credential references must be available.
This shortcut preserves accepted answers and uses the current suggestions; it does not search for another engine, provider, image, or model.
If you have edited the current answer, press Enter to accept it before delegating.
If discovery is missing, stale, conflicting, or incomplete, the shortcut explains why it cannot proceed; continue answering individually or correct the configuration.
The review refreshes discovery and checks delegated settings again before allowing a save.
Going back from review reopens delegated questions while preserving explicit answers.
These checks do not establish working inference or authorize a deployment.

The template starts a new deployment with a fresh UID.
The output defaults to `deployment.yaml` and must be a new file; an existing file is never overwritten.
Escape cancels without saving.
If an output path already exists, rerun with another `--output` path.
Review the saved YAML before deploying it; comments and input formatting are not retained.

The standalone example uses the same questionnaire:

```sh
cargo run -p nemoclaw-onboarding -- examples/onboarding/openclaw.yaml --output my-deployment.yaml
```

Use the standalone example's `--edit FILE` instead of a template to retain an existing deployment UID.
It still saves to a new output file.
Both entrypoints reject configuration the guided authoring library cannot preserve, including managed inference services and multiple sandboxes.
The other deployment examples are not all supported questionnaire inputs.

## Target checks

The Podman preset requires local Linux and is disabled on macOS and other hosts.
If a template selects Podman there, choose Docker to continue; Enter cannot accept the unavailable runtime.
This preset does not configure Podman Machine or a remote Linux host.

The CLI uses its installed verified bundle for discovery, or a bundle selected with `--bundle`:

```sh
nemoclaw onboard examples/onboarding/openclaw.yaml --bundle /path/to/bundle --output my-deployment.yaml
```

With a bundle, onboarding runs isolated OpenTofu data-source plans for the engine, hardware advertisements, selected Fabric image, and inference model catalog.
Independent requests share a plan, and duplicate requests are read once.
It re-evaluates evidence when selections change, refreshes observations whose inputs changed, and refreshes the relevant observations when entering review.
Each backend observation has a five-second timeout; each OpenTofu discovery query, including initialization when needed, has a thirty-second limit.
Discovery supports cancellation and does not pull images or start containers.
An ordinary discovery plan has a 30-second overall bound; the separate gateway query has a 35-second bound.
The [provider reference](../../docs/provider.md#engine-and-fabric-discovery) defines the observations and image metadata contract.

Without a usable bundle, onboarding uses bundled Fabric metadata and marks the target unverified.
The standalone example currently has no bundle option and uses this offline path, with local credential-availability checks.
An unreachable engine or missing image metadata remains unverified; neither establishes that a harness is unsupported.
A known engine mismatch or conflicting image platform, digest, API, tool, or interface metadata blocks review and saving until the selection is corrected.
Unknown observations still allow saving after answering individually and selecting a runtime offered on this host, including when authoring for a target to prepare later.

Observed models supplement suggestions; you can still enter an identifier manually.
The target summary distinguishes advertised hardware, unverified GPU inventory, credential-reference availability, and gateway status.
These observations do not establish deployment readiness, successful authentication for every operation, model loading, or working inference.
Complete GPU/driver/memory measurements require an explicitly selected SDK host collector; onboarding does not run it.
Plan refreshes the relevant observations; apply retains its readiness checks.

## Guided choices

Harness candidates come from a generated catalog tied to the pinned Fabric source revision, including NemoClaw's local adapters.
The authoring library intersects those candidates with the configurations it can preserve.
It retains presentation ordering, provider suggestions, and native configuration constraints; upstream support alone does not make a harness authorable.
The current guided subset is:

- OpenClaw, Hermes, Deep Agents Code, and Pi agent harnesses
- Docker and rootless Podman runtimes
- NVIDIA Endpoints, OpenRouter, OpenAI, Anthropic, Google Gemini, and custom OpenAI- or Anthropic-compatible endpoints
- Hermes Provider for the Hermes harness
- compatible APIs for each harness, a default model suggestion, and manual model identifiers

Endpoint URLs, provider identities, API protocols, and credential environment-variable references are derived from the selected provider. The wizard asks for an endpoint only for a custom compatible provider. It does not ask users to name internal provider, sandbox, or agent records.

Some onboarding journeys cannot yet be represented faithfully. They remain ignored failing behavioral tests in `crates/nemoclaw-authoring/tests/unsupported_onboarding_journeys.rs`:

- NemoCUA, llama.cpp, NVIDIA NIM, and model-router lifecycle contracts are absent from V1.
- Managed Ollama and vLLM exist in the schema, but offline onboarding lacks a qualified catalog of immutable images, model revisions, and hardware profiles.
- V1 has no sandbox CPU and RAM sizing, sandbox GPU selection, host mounts, or messaging-channel configuration.
- Desired-state policy does not preserve policy-tier and composable-preset intent.
- V1 cannot preserve trusted-private-endpoint qualification intent.

The questionnaire omits these choices.

Plan and apply require a [verified native bundle and the CLI on PATH](../../docs/build.md#build-a-native-bundle); onboarding alone does not.
After reviewing the generated YAML, follow the [deployment guide](../../docs/usage.md) and use the lifecycle commands when ready:

```sh
nemoclaw plan my-deployment.yaml
nemoclaw apply my-deployment.yaml
```

Those commands are separate actions; accepting the questionnaire's review never authorizes a deployment operation.
