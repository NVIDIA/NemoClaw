// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Command from "../lib/commands/onboard";
import { withCommandDisplay } from "../lib/cli/command-display";

export default withCommandDisplay(Command, [
  {
    usage: "nemoclaw onboard",
    description: "Configure inference endpoint and credentials",
    group: "Getting Started",
    scope: "global",
    order: 0,
  },
  {
    usage: "nemoclaw onboard --from",
    description: "Use a custom Dockerfile for the sandbox image",
    group: "Getting Started",
    scope: "global",
    order: 1,
  },
]);
