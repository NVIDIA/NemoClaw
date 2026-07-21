<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# DGX Station Express Instructions

Use these instructions only after hardware detection confirms DGX Station.

Use the selected maintained release's official installer as the authority for Station qualification, host preparation, model selection, consent, and reboot or login resume.
Do not run the Station preparation helper separately or reproduce Express by pre-setting provider and model environment variables.

The installer provides these Station Express model choices:

1. The ordinary installer defaults to `nemotron-3-ultra-550b-a55b`, served as `nvidia/nemotron-3-ultra-550b-a55b`.
2. The explicit `--station-deepseek` flag selects `deepseek-v4-flash`, served as `deepseek-ai/DeepSeek-V4-Flash`.

Both choices use the same Station detection, host-preparation, consent, suggested-policy, default-sandbox, and revision resume flow.

Before asking for consent, explain all of these boundaries:

- On generic Ubuntu, Station Express may install or change the pinned NVIDIA open driver, Docker with Buildx, NVIDIA Container Toolkit, and the reviewed factory `dkms` transition. On qualified factory images, the installer follows its bounded validation and repair path instead of replacing the factory stack.
- Official Station preparation may add the trusted local account to the `docker` group, which grants root-equivalent control and is suitable only for a trusted single-user development host.
- Official Station preparation may require an operator-controlled reboot and resumes only with the accepted NemoClaw revision.
- Nemotron Ultra Express discloses an approximately `352 GB` model download. DeepSeek Express downloads its pinned vLLM container and model data. Both require enough space on the model-cache filesystem and Docker storage.
- DGX Station remains an evaluation path with deferred end-to-end validation on physical hardware, so startup may still fail after readiness checks.

Ask: "Which DGX Station Express model would you like?"
Choices:

1. Nemotron 3 Ultra 550B, the ordinary installer default.
2. DeepSeek V4 Flash, the explicit `--station-deepseek` override.
3. Neither, let me choose the runtime and model normally.

If a Station Express model is selected:

- Set `NEMOCLAW_AGENT` to the agent already selected in the starter prompt.
- For Nemotron Ultra, run the ordinary installer without `--station-deepseek`.
- For DeepSeek, pass `--station-deepseek` and no other model-selection override.
- Do not set `NEMOCLAW_PROVIDER`, `NEMOCLAW_VLLM_MODEL`, `NEMOCLAW_MODEL`, `NEMOCLAW_NON_INTERACTIVE`, `NEMOCLAW_YES`, `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE`, or `NEMOCLAW_NO_EXPRESS`.
- Leave `NEMOCLAW_SANDBOX_NAME`, `NEMOCLAW_POLICY_TIER`, web-search settings, and messaging settings unset so the installer applies its Express defaults.
- Do not run `scripts/prepare-dgx-station-host.sh --check`, `--verify`, or `--apply` separately. The installer owns Station qualification and preparation.
- Run the installer only in a secure interactive terminal. If the coding-agent UI cannot keep the installer prompts visible and accept the user's response, stop before installation.
- Let the installer present its third-party-software notice and complete Express summary. Keep each official confirmation visible, wait for the user's response, and do not pre-answer or suppress it.
- Do not pass `--force-station-install` unless the installer rejects release metadata on genuine Station GB300 hardware and the user separately chooses the documented temporary override.
- Follow the command that the installer prints after a required reboot or login transition.

If Station Express is declined, continue with the normal provider selection.
Offer existing vLLM when a ready server is detected, managed vLLM, supported local Ollama, and every hosted or compatible provider supported by the selected agent.
