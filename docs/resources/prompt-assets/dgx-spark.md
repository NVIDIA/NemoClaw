<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# DGX Spark Express Instructions

Use these instructions only after hardware detection confirms DGX Spark.

Explain that Express keeps the selected agent, uses local vLLM with the default Qwen model, leaves optional setup at its defaults, and downloads the vLLM container and model.
Include the third-party-software notice, then ask: "Run Express install with these settings?"
Choices:

1. Yes, use the DGX Spark Express defaults.
2. No, let me choose the runtime and model.

If Express is selected:

- Set `NEMOCLAW_PROVIDER=install-vllm`.
- Leave `NEMOCLAW_VLLM_MODEL` and `NEMOCLAW_MODEL` unset so the installed release selects its DGX Spark default, currently `nvidia/Qwen3.6-35B-A3B-NVFP4`.
- Set `NEMOCLAW_AGENT` to the agent already selected in the starter prompt.
- Set `NEMOCLAW_NON_INTERACTIVE=1`, `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt`, `NEMOCLAW_YES=1`, and `NEMOCLAW_POLICY_MODE=suggested`.
- Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` when Express is accepted.
- Leave `NEMOCLAW_SANDBOX_NAME`, `NEMOCLAW_POLICY_TIER`, web-search settings, and messaging settings unset so the installer applies the remaining Express defaults.
- Treat the Express confirmation as approval for the disclosed notice, downloads, and installation, and skip the later final-permission prompt.
- Do not ask again for the agent or ask separate questions for model, sandbox name, web search, messaging, policy, download approval, or final installation approval.
- After installation, report the model selected by the installed release.

If Express is declined, continue with the normal provider selection.
Offer existing vLLM when a ready server is detected, managed vLLM, supported local Ollama, and every hosted or compatible provider supported by the selected agent.
