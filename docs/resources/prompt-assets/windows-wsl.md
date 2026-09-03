<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Windows WSL Express Instructions

Use these instructions only after official detection identifies Windows WSL.

Offer the maintained Windows Express path before the normal provider menu.
Explain that Express keeps the selected agent, uses Windows-host Ollama with its memory-aware default model, leaves optional setup at its defaults, and installs or starts Ollama and downloads the model when needed.
Include the third-party-software notice, then ask: "Run Express install with these settings?"
Choices:

1. Yes, use the Windows WSL Express defaults.
2. No, let me choose the runtime and model.

If Express is selected:

- Set `NEMOCLAW_PROVIDER=install-windows-ollama`.
- Leave `NEMOCLAW_MODEL` unset so the installed release chooses its memory-aware Ollama model.
- Set `NEMOCLAW_AGENT` to the agent already selected in the starter prompt.
- Set `NEMOCLAW_NON_INTERACTIVE=1`, `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt`, `NEMOCLAW_YES=1`, and `NEMOCLAW_POLICY_MODE=suggested`.
- Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` when Express is accepted.
- Leave `NEMOCLAW_SANDBOX_NAME`, `NEMOCLAW_POLICY_TIER`, web-search settings, and messaging settings unset so the installer applies the remaining Express defaults.
- Treat the Express confirmation as approval for the disclosed notice, downloads, and installation, and skip the later final-permission prompt.
- Do not ask again for the agent or ask separate questions for model, sandbox name, web search, messaging, policy, download approval, or final installation approval.
- Do not start a second Ollama service on the same port.

If Express is declined, continue with the normal provider selection and offer every provider supported by the selected agent on Windows WSL.
