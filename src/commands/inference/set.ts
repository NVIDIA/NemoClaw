// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/commands/inference/set";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw inference set",
    description: "Switch inference and sync OpenClaw model identity",
    flags: "--provider <provider> --model <model> [--sandbox <name>] [--no-verify]",
    group: "Services",
    scope: "global",
    order: 37,
  },
]);
