// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/commands/sandbox/doctor";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> doctor",
    description: "Run host, gateway, sandbox, and inference health checks",
    flags: "[--json]",
    group: "Sandbox Management",
    scope: "sandbox",
    order: 5,
  },
]);
