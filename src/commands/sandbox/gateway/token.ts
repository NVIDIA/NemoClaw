// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/gateway-token";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> gateway-token",
    description: "Print the OpenClaw gateway auth token to stdout",
    flags: "[--quiet|-q]",
    group: "Sandbox Management",
    scope: "sandbox",
    order: 14,
  },
]);
