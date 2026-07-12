// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";
import { serviceDeps } from "../lib/tunnel/command-support";
import { runStopCommand } from "../lib/tunnel/service-command";
import { stopAll } from "../lib/tunnel/services";

export default class DeprecatedStopCommand extends NemoClawCommand {
  static id = "stop";
  static strict = true;
  static summary = "Deprecated full stop (also releases the managed gateway port)";
  static description =
    "Stop tunnel services and release the managed host gateway port. Use 'tunnel stop' to preserve the shared gateway.";
  static usage = ["stop"];
  static examples = ["<%= config.bin %> stop"];
  static state = "deprecated" as const;
  static deprecationOptions = {
    message:
      "Deprecated: use 'nemoclaw tunnel stop' for tunnel-only shutdown. This legacy command also releases the managed host gateway port.",
  };
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(DeprecatedStopCommand);
    runStopCommand({ ...serviceDeps(), stopAll, releaseGatewayPort: true });
  }
}
