# Inference Profiles

NemoClaw ships with an inference profile defined in `blueprint.yaml`.
The profile configures an OpenShell inference provider and model route.
The agent inside the sandbox uses whichever model is active.
Inference requests are routed transparently through the OpenShell gateway.

## Profile Summary

| Profile | Provider | Model | Endpoint | Use Case |
|---|---|---|---|---|
| `default` | NVIDIA Endpoint | `nvidia/nemotron-3-super-120b-a12b` | `integrate.api.nvidia.com` | Production. Requires an NVIDIA API key. |

## Available Models

The `nvidia-nim` provider registers the following models from [build.nvidia.com](https://build.nvidia.com):

| Model ID | Label | Context Window | Max Output |
|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | Nemotron 3 Super 120B | 131,072 | 8,192 |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | Nemotron Ultra 253B | 131,072 | 4,096 |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | Nemotron Super 49B v1.5 | 131,072 | 4,096 |
| `nvidia/nemotron-3-nano-30b-a3b` | Nemotron 3 Nano 30B | 131,072 | 4,096 |

The default profile uses Nemotron 3 Super 120B.
You can switch to any model in the catalog at runtime.

## `default` -- NVIDIA Endpoint

The default profile routes inference to NVIDIA's hosted API through [build.nvidia.com](https://build.nvidia.com).

- **Provider type:** `nvidia`
- **Endpoint:** `https://integrate.api.nvidia.com/v1`
- **Model:** `nvidia/nemotron-3-super-120b-a12b`
- **Credential:** `NVIDIA_API_KEY` environment variable

Get an API key from [build.nvidia.com](https://build.nvidia.com).
The `nemoclaw onboard` command prompts for this key and stores it in `~/.nemoclaw/credentials.json`.

```console
$ openshell inference set --provider nvidia-nim --model nvidia/nemotron-3-super-120b-a12b
```

## Switching Models at Runtime

After the sandbox is running, switch models with the OpenShell CLI:

```console
$ openshell inference set --provider nvidia-nim --model <model-name>
```

The change takes effect immediately.
No sandbox restart is needed.
