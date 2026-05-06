// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/commands/sandbox/logs";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> logs",
    description: "Stream sandbox logs",
    flags: "[--follow] [--tail <lines>|-n <lines>] [--since <duration>]",
    group: "Sandbox Management",
    scope: "sandbox",
    order: 6,
  },
]);
