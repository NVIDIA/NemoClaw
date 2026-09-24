<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Example Onboarding TUI

This crate provides the terminal questionnaire used by `nemoclaw onboard` and the standalone example.
It is a trial authoring flow over `nemoclaw-authoring`.
It writes validated YAML and makes read-only checks against the configured container engine.
It does not read credential values, create deployment state, or apply resources.

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
The questionnaire skips inapplicable fields, such as API selection for a harness with only one supported API.
You can go back to change an answer.
If a change affects answers you already accepted, the questionnaire shows them before making the change.
Accept the revision to revisit affected questions, or go back to keep the current configuration.
Unrelated accepted answers are preserved and skipped when continuing forward.

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

The questionnaire calls the same engine prerequisite check used by gateway setup.
It checks the configured engine when the questionnaire starts, after changing runtime, and when entering review.
A check has a five-second timeout and supports cancellation.
An observed mismatch is shown as an unmet engine requirement.
When the engine cannot be checked, its status is unverified.
Saving the YAML remains available after selecting a runtime offered on this host.
Nothing is installed or started to repair the target.

A passing engine check does not establish deployment readiness.
This trial does not check GPU capacity, image compatibility, provider credentials, or model availability.
Plan/apply retain their own checks and obtain fresh observations.

## Guided choices

The example supports these guided authoring choices when they map to complete native desired state:

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
- Offline authoring cannot discover or validate a provider's current credential-bearing model catalog.

The questionnaire omits these choices.

Plan and apply require a [verified native bundle and the CLI on PATH](../../docs/build.md#build-a-native-bundle); onboarding alone does not.
After reviewing the generated YAML, follow the [deployment guide](../../docs/usage.md) and use the lifecycle commands when ready:

```sh
nemoclaw plan my-deployment.yaml
nemoclaw apply my-deployment.yaml
```

Those commands are separate actions; accepting the questionnaire's review never authorizes a deployment operation.
