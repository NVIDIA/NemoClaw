<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Local Inference Scope Decision

Status: Accept

Decision date: 2026-09-16

Accountable maintainer: `prekshivyas`

The Windows native preview may guide an eligible user through local model setup.
The flow downloads pinned model files, saves the local configuration, and starts OpenClaw.

Keep this feature in `packaging/windows`. Do not add it to the portable Linux installer or the core CLI.

The implementation must:

- Admit a pinned ARM64 inference engine without model weights.
- Verify each downloaded model file against its pinned size and SHA-256.
- Keep the local HTTP service on loopback and preserve the existing request guard.
- Start OpenClaw only after setup succeeds.
- Retain failure, cancellation, and duplicate-launch controls.

Reconsider this decision before production packaging, support outside the approved Windows device profile, or automatic model fallback.
