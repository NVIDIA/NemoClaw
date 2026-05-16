// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/recover-cli-command";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> recover",
    description: "Restart the sandbox gateway and dashboard port-forward",
    group: "Sandbox Management",
    scope: "sandbox",
    order: 3.5,
  },
]);
