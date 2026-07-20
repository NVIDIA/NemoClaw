<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# DGX Station DeepSeek Instructions

Use these instructions only after hardware detection confirms DGX Station.

The provider-preseeded DeepSeek path below is not the installer Express path and is allowed only on an already-prepared DGX Station.

Before asking for consent, explain all of these boundaries:

- The official `--station-deepseek` installer flow may install or change NVIDIA open driver `610.43.02`, Docker CE `29.6.1` with Buildx, NVIDIA Container Toolkit `1.19.1`, and the reviewed factory `dkms` transition from `3.0.11-1ubuntu13` to `1:3.4.0-1ubuntu1`.
- Official Station preparation may add the trusted local account to the `docker` group, which grants root-equivalent control and is suitable only for a trusted single-user development host.
- Official Station preparation may require an operator-controlled reboot and resumes only with the exact accepted NemoClaw revision.
- Both Station paths may install Node.js and the NemoClaw CLI, download a pinned vLLM container and DeepSeek V4 Flash model data, require enough space on the model-cache filesystem and Docker storage, and create a sandbox with suggested policy defaults.
- DGX Station remains an evaluation path with deferred end-to-end validation on physical hardware, so startup may still fail after readiness checks.

Both `--check` and `--verify` are non-repairing readiness modes, and neither applies host repairs.
`--verify` requires the pinned acceptance image to already be present locally and fails if the image is missing; it does not pull the image.
`--verify` is not read-only: it starts short-lived GPU test containers through both CDI (`nvidia.com/gpu=all`) and Docker `--gpus all`, consumes GPU and temporary Docker storage, and may create Docker state and logs.

Ask permission to run the selected maintained release's `scripts/prepare-dgx-station-host.sh --check` and `scripts/prepare-dgx-station-host.sh --verify` readiness modes.
Treat the host as prepared only when both modes succeed and confirm the exact Station GB300 platform, generic Ubuntu 24.04 ARM64 image, pinned driver and package versions, packaged CDI lifecycle, `nvidia.com/gpu=all`, and real CDI and `--gpus all` container access.

If either readiness mode fails, reports a mismatch, is unavailable, or has an inconclusive outcome:

- Do not set `NEMOCLAW_PROVIDER`, `NEMOCLAW_VLLM_MODEL`, `NEMOCLAW_MODEL`, `NEMOCLAW_NON_INTERACTIVE`, `NEMOCLAW_YES`, or `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE`.
- Explain that the only supported next step is the official installer with `--station-deepseek`, which owns pinned Station preparation and exact-revision reboot resume, then ask permission to start it.
- Let the official installer present its third-party-software notice and complete confirmation summary.
- Keep the official confirmation visible as the single active question, wait for the user's response, and do not pre-answer or suppress it.
- If a secure interactive terminal is unavailable, stop instead of falling back to the provider-preseeded path.

If and only if both readiness modes succeed, explain that the prepared-host path skips Station host preparation, uses DeepSeek V4 Flash in vLLM, and downloads the pinned vLLM container and model data.
Include the third-party-software notice, then ask: "Run the prepared-host DeepSeek install with these settings?"
Choices:

1. Yes, use the prepared-host DeepSeek defaults.
2. No, let me choose the runtime and model.

If the prepared-host DeepSeek path is selected:

- Set `NEMOCLAW_PROVIDER=install-vllm`.
- Set `NEMOCLAW_VLLM_MODEL=deepseek-v4-flash` and `NEMOCLAW_MODEL=deepseek-ai/DeepSeek-V4-Flash`.
- Set `NEMOCLAW_AGENT` to the agent already selected in the starter prompt.
- Set `NEMOCLAW_NON_INTERACTIVE=1`, `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt`, `NEMOCLAW_YES=1`, and `NEMOCLAW_POLICY_MODE=suggested`.
- Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` when the prepared-host DeepSeek path is accepted.
- Leave `NEMOCLAW_SANDBOX_NAME`, `NEMOCLAW_POLICY_TIER`, web-search settings, and messaging settings unset so the installer applies the remaining maintained defaults.
- Treat the prepared-host confirmation as approval for the disclosed downloads, sandbox creation, and installation, and skip the later final-permission prompt.
- Do not ask again for the agent or ask separate questions for model, sandbox name, web search, messaging, policy, download approval, or final installation approval.

If the prepared-host DeepSeek path is declined, continue with the normal provider selection.
Offer existing vLLM when a ready server is detected, managed vLLM, supported local Ollama, and every hosted or compatible provider supported by the selected agent.
