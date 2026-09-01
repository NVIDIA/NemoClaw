<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Windows WSL Express Instructions

Use these instructions only after official detection identifies Windows WSL.

Offer the maintained Windows Express path before the normal provider menu.
Explain that Express keeps the selected agent, selects the admitted local inference profile, and leaves optional setup at its defaults.
For a qualifying N1x WSL host, Express uses managed llama.cpp with Qwen 3.6 35B-A3B and downloads a pinned 20.4 GB GGUF file.
The installer checks only the preliminary Express-selection conditions.
Before managed llama.cpp starts, onboarding also requires the default local Docker context, at least 48,000 MiB of Docker memory, driver version `580.65.06` or later, Docker storage and runtime readiness, NVIDIA GPU integration, and a successful Docker Desktop GPU passthrough proof.
Before selecting managed llama.cpp, unset `DOCKER_HOST` and select Docker's `default` context.
Managed N1x WSL selection rejects other Docker selectors.
For other Windows WSL hosts, Express uses Windows-host Ollama only when local Docker Desktop is confirmed. Native Docker Engine, remote or unknown Docker targets, and failed Docker detection use WSL-local Ollama with its memory-aware default model.
Include the third-party-software notice, then ask: "Run Express install with these settings?"
Choices:

1. Yes, use the Windows WSL Express defaults.
2. No, let me choose the runtime and model.

If Express is selected:

- When the installer confirms local Docker Desktop, Arm64, the N1x Windows product identity, and at least 48,000 MiB of GPU memory, set `NEMOCLAW_PROVIDER=install-llama-cpp` and `NEMOCLAW_LLAMACPP_RECIPE=llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1`.
  Onboarding must then confirm Docker Desktop GPU passthrough before managed llama.cpp starts.
  If any required readiness check fails, stop and explain that managed llama.cpp is unavailable on this host.
- For managed llama.cpp, explain that Hugging Face authentication is optional and anonymous downloads can return HTTP 429. If needed, `HF_TOKEN` supplies a Hugging Face read token only to the temporary downloader. The token remains in the installer environment; remove `HF_TOKEN` after installation when no process needs it.
- Otherwise, when local Docker Desktop is confirmed, set `NEMOCLAW_PROVIDER=install-windows-ollama` and leave `NEMOCLAW_MODEL` unset so the installed release chooses its memory-aware Ollama model.
- For native Docker Engine, remote or unknown Docker targets, and failed Docker detection, set `NEMOCLAW_PROVIDER=install-ollama` and leave `NEMOCLAW_MODEL` unset. This installs WSL-local Ollama; the sandbox authentication proxy is used when containers cannot reach host loopback directly.
- Set `NEMOCLAW_AGENT` to the agent already selected in the starter prompt.
- Set `NEMOCLAW_NON_INTERACTIVE=1`, `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt`, `NEMOCLAW_YES=1`, and `NEMOCLAW_POLICY_MODE=suggested`.
- Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` when Express is accepted.
- Leave `NEMOCLAW_SANDBOX_NAME`, `NEMOCLAW_POLICY_TIER`, web-search settings, and messaging settings unset so the installer applies the remaining Express defaults.
- Treat the Express confirmation as approval for the disclosed notice, downloads, and installation, and skip the later final-permission prompt.
- Do not ask again for the agent or ask separate questions for model, sandbox name, web search, messaging, policy, download approval, or final installation approval.
- Do not start a second Ollama service on the same port.

If Express is declined, continue with the normal provider selection and offer every provider supported by the selected agent on Windows WSL.
