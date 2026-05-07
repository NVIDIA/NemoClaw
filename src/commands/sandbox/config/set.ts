// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/sandbox-config-set-cli-command";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> config set",
    description: "Set sandbox configuration with SSRF validation",
    group: "Sandbox Management",
    hidden: true,
    scope: "sandbox",
    order: 29,
  },
  {
    usage: "nemoclaw <name> config rotate-token",
    description: "Rotate sandbox provider credentials",
    group: "Sandbox Management",
    hidden: true,
    scope: "sandbox",
    order: 30,
  },
]);
