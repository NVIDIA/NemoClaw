// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import { runFixCoreDns } from "../../../lib/actions/dns";

export default class InternalDnsFixCoreDnsCommand extends NemoClawCommand {
  static hidden = true;
  static strict = true;
  static summary = "Internal: patch CoreDNS for local gateway DNS";
  static description = "Patch CoreDNS to use a non-loopback upstream resolver.";
  static usage = ["internal dns fix-coredns [gateway-name]"];
  static examples = ["<%= config.bin %> internal dns fix-coredns nemoclaw"];
  static args = {
    gatewayName: Args.string({ description: "OpenShell gateway name", required: false }),
  };
  static flags = {
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(InternalDnsFixCoreDnsCommand);
    const result = runFixCoreDns({ gatewayName: args.gatewayName });
    this.applyExitResult(result);
  }
}
