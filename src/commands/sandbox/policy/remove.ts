// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/policy/remove";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> policy-remove",
    description: "Remove an applied policy preset (built-in or custom)",
    flags: "(--yes, -y, --dry-run)",
    group: "Policy Presets",
    scope: "sandbox",
    order: 18,
  },
]);
