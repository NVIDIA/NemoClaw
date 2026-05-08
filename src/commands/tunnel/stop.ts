// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/commands/tunnel/stop";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw tunnel stop",
    description: "Stop the cloudflared public-URL tunnel",
    group: "Services",
    scope: "global",
    order: 33,
  },
]);
