// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

import { showStatus } from "../../lib/tunnel/services";
import { resolveDefaultSandboxName } from "../../lib/tunnel/service-command";
import { serviceDeps } from "../../lib/tunnel/command-support";

export default class TunnelStatusCommand extends NemoClawCommand {
  static id = "tunnel:status";
  static strict = true;
  static summary = "Show cloudflared tunnel status";
  static description = "Show cloudflared tunnel process and public URL status.";
  static usage = ["tunnel status"];
  static examples = ["<%= config.bin %> tunnel status"];
  static flags = {
  };

  public async run(): Promise<void> {
    await this.parse(TunnelStatusCommand);
    const deps = serviceDeps();
    showStatus({ sandboxName: resolveDefaultSandboxName(deps.listSandboxes) });
  }
}
