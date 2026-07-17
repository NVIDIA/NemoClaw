<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# DGX Station Express Instructions

Use these instructions only after hardware detection confirms DGX Station.

Explain that Express uses the default local inference setup with DeepSeek V4 Flash in vLLM.
Disclose that it downloads the pinned vLLM container and model data.
Verify that the model-cache filesystem and Docker storage have enough capacity before continuing.
Explain that DGX Station remains an evaluation path with deferred end-to-end validation on physical hardware, so startup may still fail after readiness checks.
Include the third-party-software notice, then ask: "Do you want the recommended Express Install?"
Choices:

1. Yes, use the DGX Station Express defaults.
2. No, let me choose the runtime and model.

If Express is selected:

- Set `NEMOCLAW_PROVIDER=install-vllm`.
- Set `NEMOCLAW_VLLM_MODEL=deepseek-v4-flash` and `NEMOCLAW_MODEL=deepseek-ai/DeepSeek-V4-Flash`.
- Set `NEMOCLAW_AGENT` to the agent already selected in the starter prompt.
- Set `NEMOCLAW_NON_INTERACTIVE=1`, `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt`, `NEMOCLAW_YES=1`, and `NEMOCLAW_POLICY_MODE=suggested`.
- Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` when Express is accepted.
- Leave `NEMOCLAW_SANDBOX_NAME`, `NEMOCLAW_POLICY_TIER`, web-search settings, and messaging settings unset so the installer applies the remaining Express defaults.
- Treat the Express confirmation as approval for the described setup and installation, and skip the later final-permission prompt.
- Do not ask again for the agent or ask separate questions for model, sandbox name, web search, messaging, policy, download approval, or final installation approval.

If Express is declined, continue with the normal provider selection.
Offer existing vLLM when a ready server is detected, managed vLLM, supported local Ollama, and every hosted or compatible provider supported by the selected agent.
