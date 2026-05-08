// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/commands/sandbox/connect";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> connect",
    description: "Shell into a running sandbox",
    flags: "[--probe-only]",
    group: "Sandbox Management",
    scope: "sandbox",
    order: 3,
  },
]);
