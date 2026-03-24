---
name: nemoclaw-configure-inference
description: Changes the active inference model without restarting the sandbox. Use when change inference runtime, inference routing, openclaw, openshell, switch nemoclaw inference model, switch nemoclaw inference models.
---

# Nemoclaw Configure Inference

Change the active inference model without restarting the sandbox.

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

Change the active inference model while the sandbox is running.
No restart is required.

## Step 1: Switch to a Different Model

Set the provider to `nvidia-nim` and specify a model from [build.nvidia.com](https://build.nvidia.com):

```console
$ openshell inference set --provider nvidia-nim --model nvidia/nemotron-3-super-120b-a12b
```

This requires the `NVIDIA_API_KEY` environment variable.
The `nemoclaw onboard` command stores this key in `~/.nemoclaw/credentials.json` on first run.

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

## Step 3: Available Models

The following table lists the models registered with the `nvidia-nim` provider.
You can switch to any of these models at runtime.

| Model ID | Label | Context Window | Max Output |
|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | Nemotron 3 Super 120B | 131,072 | 8,192 |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | Nemotron Ultra 253B | 131,072 | 4,096 |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | Nemotron Super 49B v1.5 | 131,072 | 4,096 |
| `nvidia/nemotron-3-nano-30b-a3b` | Nemotron 3 Nano 30B | 131,072 | 4,096 |

## Related Skills

- `nemoclaw-reference` — Inference Profiles for full profile configuration details
