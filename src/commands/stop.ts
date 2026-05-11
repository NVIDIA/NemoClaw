// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/deprecated/stop";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw stop",
    description: "Deprecated alias for 'tunnel stop'",
    group: "Services",
    deprecated: true,
    scope: "global",
    order: 35,
  },
]);
