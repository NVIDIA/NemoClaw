// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import type { MessagingBridgeHealth } from "./inventory-commands.js";
import { resolveOpenshell } from "./resolve-openshell.js";

const CONFLICT_SCRIPT =
  'tail -n 200 /tmp/gateway.log 2>/dev/null | grep -cE "getUpdates conflict|409[[:space:]:]+Conflict" || true';

export function checkMessagingBridgeHealth(
  sandboxName: string,
  channels: readonly string[] | null | undefined,
): MessagingBridgeHealth[] {
  if (!Array.isArray(channels) || !channels.includes("telegram")) return [];

  const binary = resolveOpenshell();
  if (!binary) return [];

  // `openshell sandbox exec` requires --name/-n for the sandbox name; a
  // positional there gets parsed as the first word of the command and
  // fails with exit 127 (#2018).
  const args = ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-c", CONFLICT_SCRIPT];

  try {
    const result = spawnSync(binary, args, {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) return [];
    const count = Number.parseInt((result.stdout || "").trim(), 10);
    if (!Number.isFinite(count) || count === 0) return [];
    return [{ channel: "telegram", conflicts: count }];
  } catch {
    return [];
  }
}
