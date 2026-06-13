// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PublicDisplayLayout } from "./public-display-layout";

export const SANDBOX_SESSIONS_DISPLAY_LAYOUT: Record<string, readonly PublicDisplayLayout[]> = {
  "sandbox:sessions": [
    {
      group: "Sandbox Management",
      order: 17,
      flags: "[openclaw-sessions-flags...]",
      description: "List OpenClaw conversation sessions in the sandbox",
    },
  ],
  "sandbox:sessions:list": [
    {
      group: "Sandbox Management",
      order: 17.1,
      flags: "[openclaw-sessions-list-flags...]",
      description: "List OpenClaw conversation sessions",
    },
  ],
  "sandbox:sessions:reset": [
    {
      group: "Sandbox Management",
      order: 17.2,
      flags: "<key> [--agent <id>] [--reason new|reset] [--json] [--verbose]",
      description: "Reset a session via the OpenClaw gateway",
    },
  ],
  "sandbox:sessions:delete": [
    {
      group: "Sandbox Management",
      order: 17.3,
      flags: "<key> [--agent <id>] [--keep-transcript] [--json] [--verbose]",
      description: "Delete a session entry via the OpenClaw gateway",
    },
  ],
  "sandbox:sessions:export": [
    {
      group: "Sandbox Management",
      order: 17.4,
      flags: "[keys...] [--agent <id>] [--out <path>] [--include-trajectory] [--json]",
      description: "Export OpenClaw session JSONL out of a running sandbox",
    },
  ],
};
