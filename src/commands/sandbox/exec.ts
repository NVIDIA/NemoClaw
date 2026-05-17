// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/commands/sandbox/exec";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> exec",
    description: "Run a command non-interactively in a running sandbox",
    flags: "[--workdir <dir>] [--tty|--no-tty] [--timeout <s>] -- <cmd> [args...]",
    group: "Sandbox Management",
    scope: "sandbox",
    order: 4,
  },
]);
