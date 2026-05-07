// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/commands/root/version";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw --version",
    description: "Show version",
    group: "Getting Started",
    hidden: true,
    scope: "global",
    order: 47,
  },
  {
    usage: "nemoclaw -v",
    description: "Show version",
    group: "Getting Started",
    hidden: true,
    scope: "global",
    order: 48,
  },
]);
