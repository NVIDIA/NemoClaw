// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/status";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw status",
    description: "Show sandbox list and service status",
    flags: "[--json]",
    group: "Services",
    scope: "global",
    order: 36,
  },
]);
