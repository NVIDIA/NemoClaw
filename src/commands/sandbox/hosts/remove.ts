// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/hosts/remove";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> hosts-remove",
    description: "Remove a sandbox /etc/hosts alias",
    flags: "(--dry-run)",
    group: "Policy Presets",
    scope: "sandbox",
    order: 19.3,
  },
]);
