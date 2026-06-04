// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PublicDisplayLayout } from "./public-display-layout";

export const SANDBOX_AGENTS_DISPLAY_LAYOUT: Record<string, readonly PublicDisplayLayout[]> = {
  "sandbox:agents:add": [
    {
      group: "Sandbox Management",
      order: 16.5,
      flags: "[openclaw-agents-add-flags...]",
      description: "Add an OpenClaw agent in the sandbox",
    },
  ],
  "sandbox:agents:delete": [
    {
      group: "Sandbox Management",
      order: 16.6,
      flags: "<agent-id> [openclaw-agents-delete-flags...]",
      description: "Delete an OpenClaw agent in the sandbox",
    },
  ],
};
