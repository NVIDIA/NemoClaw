// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/list";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw list",
    description: "List all sandboxes",
    flags: "[--json]",
    group: "Sandbox Management",
    scope: "global",
    order: 2,
  },
]);
