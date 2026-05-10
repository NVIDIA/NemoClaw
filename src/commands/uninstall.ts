// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/uninstall";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    // Keep the usage global even under the nemohermes alias; `nemohermes uninstall`
    // is the package uninstaller, not a sandbox-scoped action.
    usage: "nemoclaw uninstall",
    description: "Run uninstall.sh (local only; no remote fallback)",
    group: "Cleanup",
    scope: "global",
    order: 43,
  },
]);
