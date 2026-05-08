// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/uninstall";
import { CLI_NAME } from "../lib/cli/branding";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: `${CLI_NAME} uninstall`,
    description: "Run uninstall.sh (local only; no remote fallback)",
    group: "Cleanup",
    scope: "global",
    order: 43,
  },
]);
