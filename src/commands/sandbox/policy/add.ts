// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/policy/add";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> policy-add",
    description: "Add a network or filesystem policy preset",
    flags: "(--yes, -y, --dry-run, --from-file <path>, --from-dir <path>)",
    group: "Policy Presets",
    scope: "sandbox",
    order: 17,
  },
]);
