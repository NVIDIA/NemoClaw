// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapters covered through CLI integration tests. */

import { Command, Flags } from "@oclif/core";

import { CLI_NAME } from "./branding";
import * as registry from "./registry";
import { startAll, stopAll } from "./services";
import { runStartCommand, runStopCommand } from "./services-command";

function serviceDeps() {
  return {
    listSandboxes: () => registry.listSandboxes(),
  };
}

export class TunnelStartCommand extends Command {
  static id = "tunnel:start";
  static strict = true;
  static summary = "Start the cloudflared public-URL tunnel";
  static description = "Start the cloudflared public-URL tunnel for the default sandbox dashboard.";
  static usage = ["tunnel start"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(TunnelStartCommand);
    await runStartCommand({ ...serviceDeps(), startAll });
  }
}

export class TunnelStopCommand extends Command {
  static id = "tunnel:stop";
  static strict = true;
  static summary = "Stop the cloudflared public-URL tunnel";
  static description = "Stop the cloudflared public-URL tunnel for the default sandbox dashboard.";
  static usage = ["tunnel stop"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(TunnelStopCommand);
    runStopCommand({ ...serviceDeps(), stopAll });
  }
}

export class DeprecatedStartCommand extends Command {
  static id = "start";
  static strict = true;
  static summary = "Deprecated alias for 'tunnel start'";
  static description = "Deprecated alias for tunnel start.";
  static usage = ["start"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(DeprecatedStartCommand);
    this.logToStderr(
      `  Deprecated: '${CLI_NAME} start' is now '${CLI_NAME} tunnel start'. See '${CLI_NAME} help'.`,
    );
    await runStartCommand({ ...serviceDeps(), startAll });
  }
}

export class DeprecatedStopCommand extends Command {
  static id = "stop";
  static strict = true;
  static summary = "Deprecated alias for 'tunnel stop'";
  static description = "Deprecated alias for tunnel stop.";
  static usage = ["stop"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(DeprecatedStopCommand);
    this.logToStderr(
      `  Deprecated: '${CLI_NAME} stop' is now '${CLI_NAME} tunnel stop'. See '${CLI_NAME} help'.`,
    );
    runStopCommand({ ...serviceDeps(), stopAll });
  }
}
