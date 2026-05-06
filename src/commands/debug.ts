// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/debug";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw debug",
    description: "Collect diagnostics for bug reports",
    flags: "[--quick] [--sandbox NAME]",
    group: "Troubleshooting",
    scope: "global",
    order: 37,
  },
]);
