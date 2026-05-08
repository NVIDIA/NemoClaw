// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/maintenance/backup-all";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw backup-all",
    description: "Back up all sandbox state before upgrade",
    group: "Backup",
    scope: "global",
    order: 40,
  },
]);
