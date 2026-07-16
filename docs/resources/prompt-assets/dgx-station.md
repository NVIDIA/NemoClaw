<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# DGX Station Express Instructions

Use these instructions only after hardware detection confirms DGX Station.

Ask: "Do you want the recommended Express Install?"
Choices:

1. Yes, use the platform's Express model and required Balanced policy.
2. No, let me choose the runtime and model.

If Express is selected:

- Use managed vLLM and set `NEMOCLAW_PROVIDER=install-vllm`.
- Explicitly set `NEMOCLAW_VLLM_MODEL=nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4`.
- Do not leave the model unset; the ordinary managed-vLLM default can select DeepSeek and would not reproduce Express.
- Disclose that the model download is approximately 352 GB, in addition to the vLLM container and temporary download space.
- Verify the model-cache filesystem and Docker storage have sufficient capacity.
- Warn that DGX Station managed deployment has deferred end-to-end physical-hardware validation.
- Describe it as an evaluation path, not a validated production deployment.
- Explain that startup may fail despite passing initial checks.
- Ask separately for approval of the approximately 352 GB download.
- Balanced policy is required; set `NEMOCLAW_POLICY_TIER=balanced`, `NEMOCLAW_NON_INTERACTIVE=1`, and the selected `NEMOCLAW_AGENT`.
- Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` only after explaining the notice and receiving approval.
- Set `NEMOCLAW_YES=1` only after both the separate download approval and final install approval.
- Set `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt` only when required and a secure sudo prompt is available.
- Ask separately for sandbox name, web search, messaging when the selected agent supports it, download approval, and final install approval.

If Express is declined, continue with the normal provider selection.
Offer existing vLLM when a ready server is detected, managed vLLM, supported local Ollama, and every hosted or compatible provider supported by the selected agent.
