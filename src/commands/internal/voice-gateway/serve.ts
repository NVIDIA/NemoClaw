// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

import {
  assertVoiceGatewayEnabled,
  runVoiceGatewayServe,
} from "../../../lib/actions/voice-gateway/serve";
import { DEFAULT_VOICE_GATEWAY_LISTEN_PORT } from "../../../lib/voice-gateway/contracts";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class InternalVoiceGatewayServeCommand extends NemoClawCommand {
  static hidden = true;
  static strict = true;
  static summary = "Internal: serve the experimental voice gateway";
  static description =
    "Serve one authenticated runtime session through a private loopback HTTP and NDJSON adapter. Reads the deployment credential from descriptor 3 and the OpenClaw credential from descriptor 4.";
  static usage = [
    "internal voice-gateway serve --gateway-url <url> --runtime-identity <id> --runtime-profile <id> --sandbox <name> --agent <id> [--listen-port <port>]",
  ];
  static flags = {
    "gateway-url": Flags.string({
      description: "Fixed loopback OpenClaw WebSocket URL",
      required: true,
    }),
    "runtime-identity": Flags.string({
      description: "Trusted local runtime deployment identity",
      required: true,
    }),
    "runtime-profile": Flags.string({
      description: "Operator-selected runtime profile",
      required: true,
    }),
    sandbox: Flags.string({
      description: "Operator-selected sandbox",
      required: true,
    }),
    agent: Flags.string({
      description: "Operator-selected OpenClaw agent",
      required: true,
    }),
    "listen-port": Flags.integer({
      default: DEFAULT_VOICE_GATEWAY_LISTEN_PORT,
      description: "Loopback port for the private runtime adapter",
      min: 1024,
      max: 65_535,
    }),
  };

  public async run(): Promise<void> {
    assertVoiceGatewayEnabled();
    const { flags } = await this.parse(InternalVoiceGatewayServeCommand);
    await runVoiceGatewayServe({
      gatewayUrl: flags["gateway-url"],
      runtimeIdentity: flags["runtime-identity"],
      runtimeProfile: flags["runtime-profile"],
      sandbox: flags.sandbox,
      agent: flags.agent,
      listenPort: flags["listen-port"],
    });
  }
}
