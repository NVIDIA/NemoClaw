// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/share/mount";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> share mount",
    description: "Mount sandbox filesystem on the host via SSHFS",
    flags: "[sandbox-path] [local-mount-point]",
    group: "Sandbox Management",
    scope: "sandbox",
    order: 10,
  },
]);
