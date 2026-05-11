// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/deploy";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw deploy",
    description: "Deprecated Brev-specific bootstrap path",
    group: "Compatibility Commands",
    deprecated: true,
    scope: "global",
    order: 31,
  },
]);
