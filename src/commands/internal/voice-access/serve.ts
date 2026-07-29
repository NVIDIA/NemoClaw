// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import {
  DEFAULT_VOICE_ACCESS_LISTEN_PORT,
  DEFAULT_VOICE_ACCESS_UPSTREAM_PORT,
  runVoiceAccessGatewayAction,
} from "../../../lib/actions/voice-access/serve";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class InternalVoiceAccessServeCommand extends NemoClawCommand {
  static hidden = true;
  static strict = true;
  static summary = "Internal: serve the voice access gateway";
  static description = "Serve an authenticated loopback gateway for VoiceClaw WebRTC signaling.";
  static usage = [
    "internal voice-access serve --token-file <path> [--listen-port <port>] [--upstream-port <port>]",
  ];
  static examples = [
    "<%= config.bin %> internal voice-access serve --token-file /run/secrets/voice-access-token",
  ];
  static flags = {
    "token-file": Flags.string({
      description: "Absolute path to a private file containing the bearer token",
      required: true,
    }),
    "listen-port": Flags.integer({
      default: DEFAULT_VOICE_ACCESS_LISTEN_PORT,
      description: "Loopback port for authenticated client requests",
      min: 1024,
      max: 65_535,
    }),
    "upstream-port": Flags.integer({
      default: DEFAULT_VOICE_ACCESS_UPSTREAM_PORT,
      description: "Loopback port for the VoiceClaw Talker service",
      min: 1024,
      max: 65_535,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InternalVoiceAccessServeCommand);
    await runVoiceAccessGatewayAction({
      listenPort: flags["listen-port"],
      tokenFile: flags["token-file"],
      upstreamPort: flags["upstream-port"],
    });
  }
}
