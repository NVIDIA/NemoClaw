// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/commands/credentials/reset";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw credentials reset",
    description: "Remove a stored credential so onboard re-prompts",
    group: "Credentials",
    scope: "global",
    order: 39,
  },
]);
