// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/maintenance/update";
import { CLI_DISPLAY_NAME } from "../lib/cli/branding";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw update",
    description: `Run the maintained ${CLI_DISPLAY_NAME} installer update flow`,
    flags: "(--check, --yes|-y)",
    group: "Upgrade",
    scope: "global",
    order: 40,
  },
]);
