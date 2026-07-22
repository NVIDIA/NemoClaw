// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The trusted PR E2E workflow on main still dispatches the previous filename.
// The renamed workflow enters the same test through this target-specific path.
await (process.env.E2E_TARGET_ID === "bootstrap-install-smoke"
  ? import("./launchable-smoke.test.ts")
  : Promise.resolve());
