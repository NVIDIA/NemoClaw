// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/channels/add";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> channels add",
    description: "Save credentials and rebuild",
    flags: "<channel> [--dry-run]",
    group: "Messaging Channels",
    scope: "sandbox",
    order: 21,
  },
]);
