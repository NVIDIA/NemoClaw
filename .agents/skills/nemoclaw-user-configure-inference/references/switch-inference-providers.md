<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Switch Inference Models at Runtime

Change the active inference model while the sandbox is running.
No restart is required.

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

## Switch to a Different Model

Switching happens through the OpenShell inference route.
Use the provider and model that match the upstream you want to use.
This is one of the cases where a NemoClaw workflow intentionally uses `openshell`; see CLI Selection Guide (use the `nemoclaw-user-reference` skill) for the general boundary.

### NVIDIA Endpoints

```console
$ openshell inference set --provider nvidia-prod --model nvidia/nemotron-3-super-120b-a12b
```

### OpenAI

```console
$ openshell inference set --provider openai-api --model gpt-5.4
```

### Anthropic

```console
$ openshell inference set --provider anthropic-prod --model claude-sonnet-4-6
```

### Google Gemini

```console
$ openshell inference set --provider gemini-api --model gemini-2.5-flash
```

### Compatible Endpoints

If you onboarded a custom compatible endpoint, switch models with the provider created for that endpoint:

```console
$ openshell inference set --provider compatible-endpoint --model <model-name>
```

```console
$ openshell inference set --provider compatible-anthropic-endpoint --model <model-name>
```

If the provider itself needs to change, rerun `nemoclaw onboard`.

#### Switching from Responses API to Chat Completions

If onboarding selected `/v1/responses` but the agent fails at runtime (for
example, because the backend does not emit the streaming events OpenClaw
requires), re-run onboarding so the wizard re-probes the endpoint and bakes
the correct API path into the image:

```console
$ nemoclaw onboard
```

Select the same provider and endpoint again.
The updated streaming probe will detect incomplete `/v1/responses` support
and select `/v1/chat/completions` automatically.

For the compatible-endpoint provider, NemoClaw uses `/v1/chat/completions` by
default, so no env var is required to keep the safe path.
To opt in to `/v1/responses` for a backend you have verified end to end, set
`NEMOCLAW_PREFERRED_API` before onboarding:

```console
$ NEMOCLAW_PREFERRED_API=openai-responses nemoclaw onboard
```

> **Note:** `NEMOCLAW_INFERENCE_API_OVERRIDE` patches the config at container startup but
> does not update the Dockerfile ARG baked into the image.
> If you recreate the sandbox without the override env var, the image reverts to
> the original API path.
> A fresh `nemoclaw onboard` is the reliable fix because it updates both the
> session and the baked image.

## Cross-Provider Switching

Switching to a different provider family (for example, from NVIDIA Endpoints to Anthropic) requires updating both the gateway route and the sandbox config.

Set the gateway route on the host:

```console
$ openshell inference set --provider anthropic-prod --model claude-sonnet-4-6 --no-verify
```

Then set the override env vars and recreate the sandbox so they take effect at startup:

```console
$ export NEMOCLAW_MODEL_OVERRIDE="anthropic/claude-sonnet-4-6"
$ export NEMOCLAW_INFERENCE_API_OVERRIDE="anthropic-messages"
$ nemoclaw onboard --resume --recreate-sandbox
```

The entrypoint patches `openclaw.json` at container startup with the override values.
You do not need to rebuild the image.
Remove the env vars and recreate the sandbox to revert to the original model.

`NEMOCLAW_INFERENCE_API_OVERRIDE` accepts `openai-completions` (for NVIDIA, OpenAI, Gemini, compatible endpoints) or `anthropic-messages` (for Anthropic and Anthropic-compatible endpoints).
This variable is only needed when switching between provider families.

## Tune Model Metadata

The sandbox image bakes model metadata (context window, max output tokens, reasoning mode, and accepted input modalities) into `openclaw.json` at build time.
To change these values, set the corresponding environment variables before running `nemoclaw onboard` so they patch into the Dockerfile before the image builds.

| Variable | Values | Default |
|---|---|---|
| `NEMOCLAW_CONTEXT_WINDOW` | Positive integer (tokens) | `131072` |
| `NEMOCLAW_MAX_TOKENS` | Positive integer (tokens) | `4096` |
| `NEMOCLAW_REASONING` | `true` or `false` | `false` |
| `NEMOCLAW_INFERENCE_INPUTS` | `text` or `text,image` | `text` |
| `NEMOCLAW_AGENT_TIMEOUT` | Positive integer (seconds) | `600` |

Invalid values are ignored, and the default bakes into the image.
Use `NEMOCLAW_INFERENCE_INPUTS=text,image` only for a model that accepts image input through the selected provider.

```console
$ export NEMOCLAW_CONTEXT_WINDOW=65536
$ export NEMOCLAW_MAX_TOKENS=8192
$ export NEMOCLAW_REASONING=true
$ export NEMOCLAW_INFERENCE_INPUTS=text,image
$ export NEMOCLAW_AGENT_TIMEOUT=1800
$ nemoclaw onboard
```

`NEMOCLAW_AGENT_TIMEOUT` controls the per-request inference timeout baked into
`agents.defaults.timeoutSeconds`. Increase it for slow local inference (for
example, CPU-only Ollama or vLLM on modest hardware). `openclaw.json` is
immutable at runtime, so this value can only be changed by rebuilding the
sandbox via `nemoclaw onboard`.

These variables are build-time settings.
If you change them on an existing sandbox, recreate the sandbox so the new values bake into the image:

```console
$ nemoclaw onboard --resume --recreate-sandbox
```

## Verify the Active Model

Run the status command to confirm the change:

```console
$ nemoclaw <name> status
```

Add the `--json` flag for machine-readable output:

```console
$ nemoclaw <name> status --json
```

The output includes the active provider, model, and endpoint.

## Notes

- The host keeps provider credentials.
- The sandbox continues to use `inference.local`.
- Same-provider model switches take effect immediately via the gateway route alone.
- Cross-provider switches also require `NEMOCLAW_MODEL_OVERRIDE` (and `NEMOCLAW_INFERENCE_API_OVERRIDE`) plus a sandbox recreate so the entrypoint patches the config at startup.
- Overrides are applied at container startup. Changing or removing env vars requires a sandbox recreate to take effect.
- Local Ollama and local vLLM routes use local provider tokens rather than `OPENAI_API_KEY`. Rebuilds of older local-inference sandboxes clear the stale OpenAI credential requirement automatically.

## Related Topics

- Inference Options (use the `nemoclaw-user-configure-inference` skill) for the full list of providers available during onboarding.
