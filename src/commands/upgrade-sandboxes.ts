// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/maintenance/upgrade-sandboxes";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw upgrade-sandboxes",
    description: "Detect and rebuild stale sandboxes",
    flags: "(--check, --auto, --yes|-y)",
    group: "Upgrade",
    scope: "global",
    order: 41,
  },
]);
