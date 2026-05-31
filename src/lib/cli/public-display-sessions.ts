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
      order: 18,
      flags: "[openclaw-sessions-list-flags...]",
      description: "List OpenClaw conversation sessions",
    },
  ],
  "sandbox:sessions:cleanup": [
    {
      group: "Sandbox Management",
      order: 20,
      flags: "[openclaw-sessions-cleanup-flags...]",
      description: "Run OpenClaw session-store maintenance",
    },
  ],
  "sandbox:sessions:reset": [
    {
      group: "Sandbox Management",
      order: 21,
      flags: "<agent> <session> [--reason new|reset]",
      description: "Reset a session via the OpenClaw gateway",
    },
  ],
  "sandbox:sessions:export-trajectory": [
    {
      group: "Sandbox Management",
      order: 22,
      flags: "<agent> <session> [--output <name>] [--workspace <dir>] [--save-host <dir>] [--json]",
      description: "Export a redacted OpenClaw session trajectory bundle",
    },
  ],
};
