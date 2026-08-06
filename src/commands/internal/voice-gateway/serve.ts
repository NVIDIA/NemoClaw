// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import {
  DEFAULT_VOICE_GATEWAY_PORT,
  runVoiceGatewayAction,
} from "../../../lib/actions/voice-gateway/serve";
import {
  VOICE_MAX_SESSION_LIFETIME_MS,
  VOICE_MAX_TURN_TIMEOUT_MS,
} from "../../../lib/domain/voice/session-service";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

export default class InternalVoiceGatewayServeCommand extends NemoClawCommand {
  static hidden = true;
  static strict = true;
  static summary = "Internal: serve the experimental voice gateway";
  static description =
    "Serve the loopback-only runtime-to-agent boundary for one configured OpenClaw agent.";
  static usage = [
    "internal voice-gateway serve --admission-credential-file <path> --openclaw-credential-file <path> --openclaw-endpoint <url> --runtime-id <id> --runtime-profile <profile> --sandbox <name> --agent <id>",
  ];
  static flags = {
    "admission-credential-file": Flags.string({
      required: true,
      description: "Owner-only deployment credential file",
    }),
    "openclaw-credential-file": Flags.string({
      required: true,
      description: "Owner-only OpenClaw credential file",
    }),
    "openclaw-endpoint": Flags.string({
      required: true,
      description: "Configured loopback OpenClaw WebSocket endpoint",
    }),
    "runtime-id": Flags.string({
      required: true,
      description: "Configured runtime deployment identity",
    }),
    "runtime-profile": Flags.string({ required: true, description: "Configured runtime profile" }),
    sandbox: Flags.string({ required: true, description: "Configured sandbox" }),
    agent: Flags.string({ required: true, description: "Configured OpenClaw agent" }),
    "listen-port": Flags.integer({
      default: DEFAULT_VOICE_GATEWAY_PORT,
      min: 1024,
      max: 65_535,
      description: "Loopback HTTP listener port",
    }),
    "session-lifetime-ms": Flags.integer({
      min: 1,
      max: VOICE_MAX_SESSION_LIFETIME_MS,
      description: "Voice session lifetime in milliseconds",
    }),
    "turn-timeout-ms": Flags.integer({
      min: 1,
      max: VOICE_MAX_TURN_TIMEOUT_MS,
      description: "Committed-turn deadline in milliseconds",
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InternalVoiceGatewayServeCommand);
    await runVoiceGatewayAction({
      admissionCredentialFile: flags["admission-credential-file"],
      openClawCredentialFile: flags["openclaw-credential-file"],
      openClawEndpoint: flags["openclaw-endpoint"],
      runtimeId: flags["runtime-id"],
      runtimeProfile: flags["runtime-profile"],
      sandbox: flags.sandbox,
      agent: flags.agent,
      listenPort: flags["listen-port"],
      sessionLifetimeMs: flags["session-lifetime-ms"],
      turnTimeoutMs: flags["turn-timeout-ms"],
    });
  }
}
