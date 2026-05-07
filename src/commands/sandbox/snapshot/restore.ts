// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/snapshot/restore";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> snapshot restore",
    description: "Restore state from a snapshot",
    flags: "[selector] [--to <dst>]",
    group: "Sandbox Management",
    scope: "sandbox",
    order: 9,
  },
]);
