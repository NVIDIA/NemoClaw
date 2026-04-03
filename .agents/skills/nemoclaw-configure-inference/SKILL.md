---
name: nemoclaw-configure-inference
description: Changes the active inference model without restarting the sandbox. Use when switching inference providers, changing the model runtime, or reconfiguring inference routing.
---

# NemoClaw Configure Inference

Changes the active inference model without restarting the sandbox. Use when switching inference providers, changing the model runtime, or reconfiguring inference routing.

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

Change the active inference model while the sandbox is running.
No restart is required.

## Step 1: Switch to a Different Model

Switching happens through the OpenShell inference route.
Use the provider and model that match the upstream you want to use.

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

## Step 2: Verify the Active Model

Run the status command to confirm the change:

```console
$ nemoclaw <name> status
```

Add the `--json` flag for machine-readable output:

```console
$ nemoclaw <name> status --json
```

The output includes the active provider, model, and endpoint.

## Step 3: Notes

- The host keeps provider credentials.
- The sandbox continues to use `inference.local`.
- Runtime switching changes the OpenShell route. It does not rewrite your stored credentials.

## Related Skills

- `nemoclaw-reference` — Inference Profiles for full profile configuration details
