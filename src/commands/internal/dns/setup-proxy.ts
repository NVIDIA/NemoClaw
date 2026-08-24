// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import { runAuthorityBoundDnsSetup } from "../../../lib/actions/dns/authority-bound-setup";

export default class InternalDnsSetupProxyCommand extends NemoClawCommand {
  static hidden = true;
  static strict = true;
  static summary = "Internal: configure sandbox DNS proxy";
  static description = "Configure the DNS forwarder bridge inside a sandbox pod.";
  static usage = ["internal dns setup-proxy <gateway-name> <sandbox-name> [policy-authority]"];
  static examples = ["<%= config.bin %> internal dns setup-proxy nemoclaw my-sandbox"];
  static args = {
    gatewayName: Args.string({ description: "OpenShell gateway name", required: true }),
    sandboxName: Args.string({ description: "Sandbox name", required: true }),
    policyAuthority: Args.string({
      description: "Policy authority receipt for an unregistered sandbox",
      required: false,
    }),
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(InternalDnsSetupProxyCommand);
    const result = runAuthorityBoundDnsSetup({
      gatewayName: args.gatewayName,
      sandboxName: args.sandboxName,
      recordedPolicyAuthority: args.policyAuthority,
    });
    this.applyExitResult(result);
  }
}
