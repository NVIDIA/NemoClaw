<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# DGX Spark Express Instructions

Use these instructions only after hardware detection confirms DGX Spark.

Ask: "Do you want the recommended Express Install?"
Choices:

1. Yes, use the platform's Express model and required Balanced policy.
2. No, let me choose the runtime and model.

If Express is selected:

- Use managed vLLM and set `NEMOCLAW_PROVIDER=install-vllm`.
- Leave `NEMOCLAW_VLLM_MODEL` unset so the installed maintained release selects its current Spark Express model.
- Explain container and model download sizes before asking permission.
- Report the model selected by the installed release.
- Balanced policy is required; set `NEMOCLAW_POLICY_TIER=balanced`, `NEMOCLAW_NON_INTERACTIVE=1`, and the selected `NEMOCLAW_AGENT`.
- Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` only after explaining the notice and receiving approval.
- Set `NEMOCLAW_YES=1` only after both the separate download approval and final install approval.
- Set `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt` only when required and a secure sudo prompt is available.
- Ask separately for sandbox name, web search, messaging when the selected agent supports it, download approval, and final install approval.

If Express is declined, continue with the normal provider selection.
Offer existing vLLM when a ready server is detected, managed vLLM, supported local Ollama, and every hosted or compatible provider supported by the selected agent.
