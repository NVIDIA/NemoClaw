// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/snapshot/create";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> snapshot create",
    description: "Create a snapshot of sandbox state",
    flags: "[--name <name>]",
    group: "Sandbox Management",
    scope: "sandbox",
    order: 7,
  },
]);
