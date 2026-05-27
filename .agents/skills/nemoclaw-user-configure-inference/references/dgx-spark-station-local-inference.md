<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Set Up DGX Spark or DGX Station Local Inference

Use this guide when you want NemoClaw to run with local inference on DGX Spark or DGX Station.
It pulls together the host checks, provider choice, onboarding flow, and the common Spark-specific failure modes that are otherwise spread across the quickstart, local inference, and troubleshooting pages.

## Prerequisites

Before onboarding, verify the host basics:

- Docker is installed and running.
- Node.js 22.16 or later and npm 10 or later are available.
- The NVIDIA driver and container toolkit are installed.
- `nvidia-smi` works on the host.
- Port `3000` is free, or you are ready to choose a different dashboard port.

Run:

```bash
docker info
nvidia-smi
node --version
npm --version
```

DGX Spark and recent Docker installations can require NVIDIA Container Device Interface (CDI) specs for GPU passthrough.
NemoClaw checks and repairs the common missing-CDI case during install, but you can pre-generate the spec when needed:

```bash
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
```

If this command is unavailable, install or repair the NVIDIA Container Toolkit before onboarding.

## Choose a Local Inference Path

DGX Spark and DGX Station have two common local-inference paths.

| Path | Best for | Notes |
|---|---|---|
| Managed vLLM | Tool-heavy agents, stronger tool-call reliability, larger GPU-backed models | Offered by default on DGX Spark and DGX Station. Uses `Qwen/Qwen3.6-27B-FP8` unless you override the registry slug. |
| Ollama | Simpler local chat, existing Ollama model libraries, quick experiments | Convenient, but some model/template combinations can emit tool calls as plain text. Use vLLM when tool-call reliability matters. |

For managed vLLM, the first run pulls the container image and model weights into local caches.
Plan for a long first run on fresh systems.

For Ollama, make sure only one daemon owns port `11434`.
If another runtime is already using that port, stop it or move one service before onboarding.

## Run Onboarding

Start the standard onboard wizard:

```bash
nemoclaw onboard
```

On DGX Spark and DGX Station, the interactive wizard prompts for the provider and policy choices after the third-party software notice.
Choose the local-inference path and review the suggested policy defaults before NemoClaw creates the sandbox.

If you prefer to choose manually:

1. Select the local provider you want: **Local vLLM** or **Local Ollama**.
2. For managed vLLM, accept the default model or set `NEMOCLAW_VLLM_MODEL` before running onboarding.
3. For Ollama, choose an installed model or a starter model that fits available memory.
4. Let NemoClaw validate the local endpoint before it creates the sandbox.

For non-interactive managed vLLM setup on DGX Spark or DGX Station:

```bash
NEMOCLAW_PROVIDER=install-vllm nemoclaw onboard --non-interactive --yes --yes-i-accept-third-party-software
```

To choose a supported managed-vLLM model:

```bash
NEMOCLAW_PROVIDER=install-vllm \
NEMOCLAW_VLLM_MODEL=qwen3.6-27b \
nemoclaw onboard --non-interactive --yes --yes-i-accept-third-party-software
```

Supported managed-vLLM slugs are listed in [Use a Local Inference Server](../SKILL.md#override-the-managed-vllm-model).

## Verify the Setup

After onboarding completes, check the sandbox and local inference route:

```bash
nemoclaw <sandbox-name> status
nemoclaw <sandbox-name> doctor
```

Healthy output should show:

- The sandbox is running.
- The dashboard is reachable.
- The selected inference provider is healthy.
- For Ollama, the authenticated proxy health line is healthy when the proxy token is available.

Open the TUI:

```bash
nemoclaw <sandbox-name> connect
openclaw tui
```

Ask for a small tool-using action.
If you see raw JSON tool calls printed as chat text, switch to vLLM with a parser-aware model path and review [Tool-Calling Reliability](tool-calling-reliability.md).

## Common DGX Spark and Station Fixes

### CoreDNS CrashLoop

If CoreDNS in the embedded k3s cluster crashes shortly after setup, run the CoreDNS fix script referenced by the troubleshooting guide, then recreate the sandbox.
The issue is usually a resolver path that points at `127.0.0.11`, which does not route inside the gateway container.

### k3s Image Pull or Upload Takes Too Long

Fresh systems may spend several minutes pulling images, uploading layers to the OpenShell gateway, or loading model weights.
If readiness times out while the host is still doing real work, raise both local inference and sandbox readiness budgets:

```bash
export NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=300
export NEMOCLAW_SANDBOX_READY_TIMEOUT=600
nemoclaw onboard
```

### CDI GPU Errors

If gateway startup reports `unresolvable CDI devices nvidia.com/gpu=all`, regenerate CDI specs and rerun onboarding:

```bash
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
nemoclaw onboard
```

If the error persists, repair the NVIDIA Container Toolkit installation and verify that `docker info` reports the expected CDI spec directories.

### Port 3000 Conflict

Some Spark systems already run services on port `3000`.
Set a different dashboard port before onboarding:

```bash
export NEMOCLAW_DASHBOARD_PORT=18789
nemoclaw onboard
```

Use a free port that does not overlap the configured gateway, vLLM, Ollama, or Ollama proxy ports.

## Next Steps

- [Use a Local Inference Server](../SKILL.md) for full Ollama, vLLM, NIM, and compatible-endpoint details.
- [Tool-Calling Reliability](tool-calling-reliability.md) for choosing between Ollama and parser-aware vLLM.
- Troubleshooting (use the `nemoclaw-user-reference` skill) for deeper DGX Spark failure-mode guidance.
