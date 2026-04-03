# Support Matrix

Use this page to check the current support status for host platforms, container runtimes, inference providers, and deployment paths.
This page consolidates the compatibility details that are otherwise spread across the quickstart, inference, deployment, and security docs.

## Host Platforms and Container Runtimes

The following table summarizes the current host platform and runtime combinations for the standard NemoClaw install and onboard flow.

| Host platform | Container runtime | Status | Notes |
|---|---|---|---|
| Linux | Docker | Supported | Primary supported path for local and remote installs. |
| macOS (Apple Silicon) | Colima | Supported | Install Xcode Command Line Tools and start Colima before running the installer. |
| macOS (Apple Silicon) | Docker Desktop | Supported | Start Docker Desktop before running the installer. |
| macOS (Intel) | Podman | Not supported | Depends on OpenShell support for Podman on macOS. |
| Windows WSL | Docker Desktop with WSL backend | Supported | Supported target path for WSL-based installs. |
| DGX Spark | Docker | Supported with additional setup | Follow the DGX Spark setup guide for cgroup v2 and Docker configuration. |

## Inference Provider Support

The following provider paths are available in the current product surface.

| Provider path | Status | Notes |
|---|---|---|
| NVIDIA Endpoints | Supported | Uses hosted models on `integrate.api.nvidia.com`. |
| OpenAI | Supported | Uses native OpenAI-compatible model IDs. |
| Other OpenAI-compatible endpoint | Supported | For compatible proxies and gateways. |
| Anthropic | Supported | Uses the `anthropic-messages` provider flow. |
| Other Anthropic-compatible endpoint | Supported | For Claude-compatible proxies and gateways. |
| Google Gemini | Supported | Uses Google's OpenAI-compatible endpoint. |
| Local Ollama | Supported | Available in the standard onboarding flow when Ollama is installed or already running on the host. |
| Local NVIDIA NIM | Experimental | Requires `NEMOCLAW_EXPERIMENTAL=1` and a NIM-capable GPU. |
| Local vLLM | Experimental | Requires `NEMOCLAW_EXPERIMENTAL=1` and an existing `localhost:8000` service. |

## Deployment Paths

The following deployment paths are documented today.

| Deployment path | Status | Notes |
|---|---|---|
| Local host install | Supported | Standard `curl | bash` install path. |
| Remote GPU instance | Supported | Follow the remote GPU deployment guide. |
| Telegram bridge | Supported | Requires host-side bridge setup after sandbox creation. |
| Sandbox hardening profiles | Supported | Available through the documented hardening guidance and policy controls. |

## Version and Environment Requirements

The following runtime requirements apply across the supported paths above.

| Dependency | Requirement |
|---|---|
| Linux | Ubuntu 22.04 LTS or later |
| Node.js | 22.16 or later |
| npm | 10 or later |
| OpenShell | Installed before use |
| RAM | 8 GB minimum, 16 GB recommended |
| Disk | 20 GB free minimum, 40 GB recommended |

If your platform or runtime falls outside this matrix, expect partial support, experimental behavior, or onboarding failures.
If a path is marked experimental, treat it as subject to change without compatibility guarantees.

## Next Steps

- Use the Quickstart (see the `nemoclaw-get-started` skill) to install NemoClaw on a supported platform.
- Use Inference Profiles (see the `nemoclaw-reference` skill) to compare provider-specific behavior and validation.
- Use Deploy to a Remote GPU Instance (see the `nemoclaw-deploy-remote` skill) for persistent remote deployment.
- Use Troubleshooting (see the `nemoclaw-reference` skill) if your environment does not match the supported matrix.
