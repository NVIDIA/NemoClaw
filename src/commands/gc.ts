// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/maintenance/gc";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw gc",
    description: "Remove orphaned sandbox Docker images",
    flags: "(--yes|-y|--force, --dry-run)",
    group: "Cleanup",
    scope: "global",
    order: 42,
  },
]);
