// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/commands/sandbox/destroy";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw <name> destroy",
    description: "Stop NIM + delete sandbox",
    flags: "[--yes|-y|--force] [--cleanup-gateway|--no-cleanup-gateway]",
    group: "Sandbox Management",
    scope: "sandbox",
    order: 15,
  },
]);
