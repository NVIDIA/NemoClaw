// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/share/status";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> share status",
    description: "Check whether the sandbox filesystem is currently mounted",
    flags: "[local-mount-point]",
    group: "Sandbox Management",
    scope: "sandbox",
    order: 12,
  },
]);
