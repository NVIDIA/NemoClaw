// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../../lib/commands/sandbox/channels/list";
import { withCommandDisplay } from "../../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> channels list",
    description: "List supported messaging channels",
    group: "Messaging Channels",
    scope: "sandbox",
    order: 20,
  },
]);
