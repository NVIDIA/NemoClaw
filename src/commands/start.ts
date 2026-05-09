// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/deprecated/start";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw start",
    description: "Deprecated alias for 'tunnel start'",
    group: "Services",
    deprecated: true,
    scope: "global",
    order: 34,
  },
]);
