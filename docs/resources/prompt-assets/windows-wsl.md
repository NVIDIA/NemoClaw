<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Windows WSL Express Instructions

Use these instructions only after official detection identifies Windows WSL.

Offer the maintained Windows Express path before the normal provider menu.
Explain that Express keeps the selected agent, selects the admitted local inference profile, and leaves optional setup at its defaults.
For a qualifying N1x WSL host, Express uses managed llama.cpp with Qwen 3.6 35B-A3B and downloads a pinned 20.4 GB GGUF file.
The installer leaves provider, model, and recipe selection to onboarding.
Before managed llama.cpp starts, onboarding requires Linux Arm64 WSL, one proof-backed GPU whose normalized identity is either `NVIDIA RTX Spark N1X` or `NVIDIA RTX Spark N1X (6144-core Blackwell RTX GPU)`, the default local Docker context, at least 48,000 MiB of Docker and GPU memory, driver version `580.65.06` or later, Docker storage and runtime readiness, NVIDIA GPU integration, and successful Docker Desktop GPU passthrough.
Before selecting managed llama.cpp, unset `DOCKER_HOST` and select Docker's `default` context.
Managed N1x WSL selection rejects other Docker selectors.
For other Windows WSL hosts, Express uses WSL-local Ollama with its memory-aware default model.
Include the third-party-software notice, then ask: "Run Express install with these settings?"
Choices:

1. Yes, use the Windows WSL Express defaults.
2. No, let me choose the runtime and model.

If Express is selected:

- Leave `NEMOCLAW_PROVIDER` and `NEMOCLAW_MODEL` unset.
  Leave `NEMOCLAW_LLAMACPP_RECIPE` unset for the automatic Qwen recipe, or set it to a compatible recipe ID to make the managed recipe explicit.
  Onboarding selects managed llama.cpp only after the complete N1x WSL readiness contract passes.
  If N1x readiness does not match before managed selection starts, onboarding selects WSL-local Ollama. If a required check fails after selection starts, onboarding stops before installation.
- For managed llama.cpp, explain that Hugging Face authentication is optional and anonymous downloads can return HTTP 429. If needed, `HF_TOKEN` supplies a Hugging Face read token only to the temporary downloader. The token remains in the installer environment; remove `HF_TOKEN` after installation when no process needs it.
- For other WSL hosts, onboarding installs WSL-local Ollama and uses the sandbox authentication proxy, including when Docker Desktop can reach host loopback directly.
- Set `NEMOCLAW_AGENT` to the agent already selected in the starter prompt.
- Set `NEMOCLAW_NON_INTERACTIVE=1`, `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt`, `NEMOCLAW_YES=1`, and `NEMOCLAW_POLICY_MODE=suggested`.
- Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` when Express is accepted.
- Leave `NEMOCLAW_SANDBOX_NAME`, `NEMOCLAW_POLICY_TIER`, web-search settings, and messaging settings unset so the installer applies the remaining Express defaults.
- Treat the Express confirmation as approval for the disclosed notice, downloads, and installation, and skip the later final-permission prompt.
- Do not ask again for the agent or ask separate questions for model, sandbox name, web search, messaging, policy, download approval, or final installation approval.
- Do not start a second Ollama service on the same port.
- Do not set Windows `OLLAMA_HOST` to `0.0.0.0:11434`.

If Express is declined, continue with the normal provider selection and offer every provider supported by the selected agent on Windows WSL.
