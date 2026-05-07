// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/commands/root/help";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw help",
    description: "Show help",
    group: "Getting Started",
    hidden: true,
    scope: "global",
    order: 44,
  },
  {
    usage: "nemoclaw --help",
    description: "Show help",
    group: "Getting Started",
    hidden: true,
    scope: "global",
    order: 45,
  },
  {
    usage: "nemoclaw -h",
    description: "Show help",
    group: "Getting Started",
    hidden: true,
    scope: "global",
    order: 46,
  },
]);
