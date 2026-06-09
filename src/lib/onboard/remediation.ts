// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

const OPENCLAW_LAUNCH_AGENT_PLIST = "~/Library/LaunchAgents/ai.openclaw.gateway.plist";

export function printRemediationActions(
  actions: Array<{ title: string; reason: string; commands?: string[] }> | null | undefined,
): void {
  if (!Array.isArray(actions) || actions.length === 0) {
    return;
  }

  console.error("");
  console.error("  Suggested fix:");
  console.error("");
  for (const action of actions) {
    console.error(`  - ${action.title}: ${action.reason}`);
    for (const command of action.commands || []) {
      console.error(`    ${command}`);
    }
  }
}

export function getFutureShellPathHint(
  binDir: string,
  pathValue = process.env.PATH || "",
): string | null {
  const parts = String(pathValue).split(path.delimiter).filter(Boolean);
  if (parts[0] === binDir) {
    return null;
  }
  return `export PATH="${binDir}:$PATH"`;
}

export function getPortConflictServiceHints(platform = process.platform): string[] {
  if (platform === "darwin") {
    return [
      "       # or, if it's a launchctl service (macOS):",
      "       launchctl list | grep -i claw   # columns: PID | ExitStatus | Label",
      `       launchctl unload ${OPENCLAW_LAUNCH_AGENT_PLIST}`,
      "       # or: launchctl bootout gui/$(id -u)/ai.openclaw.gateway",
    ];
  }
  return [
    "       # or, if it's a systemd service:",
    "       systemctl --user stop openclaw-gateway.service",
  ];
}
