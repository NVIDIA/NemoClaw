<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Windows WSL Express Instructions

Use these instructions only after official detection identifies Windows WSL.

Offer the maintained Windows Express path before the normal provider menu.
Explain that it uses Windows-host Ollama through Docker Desktop WSL integration.

If Express is selected:

- Set `NEMOCLAW_PROVIDER=install-windows-ollama` and let the installed release choose its maintained Ollama model.
- Balanced policy is required; set `NEMOCLAW_POLICY_TIER=balanced`, `NEMOCLAW_NON_INTERACTIVE=1`, and the selected `NEMOCLAW_AGENT`.
- Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` only after explaining the notice and receiving approval.
- Set `NEMOCLAW_YES=1` only after both the separate download approval and final install approval.
- Set `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt` only when required and a secure sudo prompt is available.
- Ask separately for sandbox name, web search, messaging when the selected agent supports it, download approval, and final install approval.
- Do not start a second Ollama service on the same port.

If Express is declined, continue with the normal provider selection and offer every provider supported by the selected agent on Windows WSL.
