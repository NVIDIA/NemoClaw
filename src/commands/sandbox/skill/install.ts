// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/skill/install";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> skill install",
    description: "Deploy a skill directory to the sandbox",
    group: "Skills",
    scope: "sandbox",
    order: 16,
  },
]);
