// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/config/get";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> config get",
    description: "Get sandbox configuration",
    flags: "[--key <dotpath>] [--format json|yaml]",
    group: "Sandbox Management",
    hidden: true,
    scope: "sandbox",
    order: 28,
  },
]);
