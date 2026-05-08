// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/commands/sandbox/rebuild";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> rebuild",
    description: "Upgrade sandbox to current agent version",
    flags: "[--yes|-y|--force] [--verbose|-v]",
    group: "Sandbox Management",
    scope: "sandbox",
    order: 13,
  },
]);
