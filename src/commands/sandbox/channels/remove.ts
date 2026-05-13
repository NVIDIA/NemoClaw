// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/channels/remove";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> channels remove",
    description: "Remove a configured messaging channel",
    flags: "<channel> [--dry-run]",
    group: "Messaging Channels",
    scope: "sandbox",
    order: 22,
  },
]);
