// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import { runSetupDnsProxy } from "../../../lib/actions/dns";

export default class InternalDnsSetupProxyCommand extends NemoClawCommand {
  static hidden = true;
  static strict = true;
  static summary = "Internal: configure sandbox DNS proxy";
  static description = "Configure the DNS forwarder bridge inside a sandbox pod.";
  static usage = ["internal dns setup-proxy <gateway-name> <sandbox-name>"];
  static examples = ["<%= config.bin %> internal dns setup-proxy nemoclaw my-sandbox"];
  static args = {
    gatewayName: Args.string({ description: "OpenShell gateway name", required: true }),
    sandboxName: Args.string({ description: "Sandbox name", required: true }),
  };
  static flags = {
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(InternalDnsSetupProxyCommand);
    const result = runSetupDnsProxy({ gatewayName: args.gatewayName, sandboxName: args.sandboxName });
    this.applyExitResult(result);
  }
}
