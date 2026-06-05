// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../cli/branding";
import * as registry from "../state/registry";

export function serviceDeps() {
  return {
    listSandboxes: () => registry.listSandboxes(),
  };
}

export function printTunnelUsage(log: (message?: string) => void = console.log): void {
  log("");
  log(`  Usage: ${CLI_NAME} tunnel <subcommand>`);
  log("");
  log("  Subcommands:");
  log("    start                 Start the cloudflared public-URL tunnel");
  log("    stop                  Stop the cloudflared public-URL tunnel");
  log("    status                Show cloudflared public-URL tunnel status");
  log("");
}
