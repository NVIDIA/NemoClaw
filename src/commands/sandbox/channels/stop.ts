// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/channels/stop";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> channels stop",
    description: "Disable channel (keeps credentials)",
    flags: "<channel> [--dry-run]",
    group: "Messaging Channels",
    scope: "sandbox",
    order: 23,
  },
]);
