// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../../lib/commands/inference/get";
import { withCommandDisplay } from "../../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw inference get",
    description: "Show the active inference provider and model",
    flags: "[--json]",
    group: "Services",
    scope: "global",
    order: 36,
  },
]);
