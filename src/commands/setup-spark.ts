// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/setup-spark";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw setup-spark",
    description: "Deprecated alias for nemoclaw onboard",
    group: "Compatibility Commands",
    deprecated: true,
    scope: "global",
    order: 30,
  },
]);
