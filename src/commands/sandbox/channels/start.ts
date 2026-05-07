// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/channels/start";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> channels start",
    description: "Re-enable a previously stopped channel",
    flags: "<channel> [--dry-run]",
    group: "Messaging Channels",
    scope: "sandbox",
    order: 24,
  },
]);
