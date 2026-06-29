// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import * as sandboxConfig from "../../../lib/sandbox/config";

const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});

export default class SandboxConfigRotateTokenCommand extends NemoClawCommand {
  static id = "sandbox:config:rotate-token";
  static hidden = true;
  static strict = true;
  static summary = "Rotate sandbox provider credentials";
  static description =
    "Rotate sandbox provider credentials through the configured OpenShell provider.";
  static usage = ["<name> [--from-env <VAR>] [--stdin]"];
  static examples = [
    "<%= config.bin %> sandbox config rotate-token alpha",
    "<%= config.bin %> sandbox config rotate-token alpha --from-env NVIDIA_INFERENCE_API_KEY",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    "from-env": Flags.string({
      description: "Read the replacement credential from this environment variable",
    }),
    stdin: Flags.boolean({ description: "Read the replacement credential from stdin" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxConfigRotateTokenCommand);
    try {
      await sandboxConfig.configRotateToken(args.sandboxName, {
        fromEnv: flags["from-env"] ?? null,
        fromStdin: flags.stdin ?? false,
      });
    } catch (error) {
      if (error instanceof sandboxConfig.SandboxConfigError) {
        this.failWithLines(error.lines, error.exitCode);
        return;
      }
      throw error;
    }
  }
}
