// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/shields/up";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> shields up",
    description: "Raise sandbox security shields",
    group: "Sandbox Management",
    hidden: true,
    scope: "sandbox",
    order: 26,
  },
]);
