// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { runCredentialsAddAction } from "../../lib/actions/credentials-add";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class CredentialsAddCommand extends NemoClawCommand {
  static id = "credentials:add";
  static strict = true;
  static summary = "Register a provider credential";
  static description =
    "Register a provider credential with the OpenShell gateway so workloads in NemoClaw sandboxes can authenticate to the corresponding endpoint without holding the raw secret. Pass the env variable name; the value is read from the host environment and never enters argv.";
  static usage = [
    "credentials add <PROVIDER> --type <TYPE> [--credential ENV_NAME] [--config K=V] [--from-existing]",
  ];
  static examples = [
    "<%= config.bin %> credentials add tavily-search --type tavily --credential TAVILY_API_KEY",
    "<%= config.bin %> credentials add nvidia-prod --type nvidia --credential NVIDIA_INFERENCE_API_KEY",
    "<%= config.bin %> credentials add claude --type claude-code --from-existing",
  ];
  static args = {
    provider: Args.string({
      name: "PROVIDER",
      description: "OpenShell provider name",
      ignoreStdin: true,
      required: true,
    }),
  };
  static flags = {
    type: Flags.string({
      description: "Provider type (e.g. tavily, nvidia, openai, anthropic, generic)",
      required: true,
    }),
    credential: Flags.string({
      description:
        "Env variable name whose value holds the credential (must already be exported). Repeatable.",
      multiple: true,
    }),
    config: Flags.string({
      description: "Provider configuration pair (KEY=VALUE). Repeatable.",
      multiple: true,
    }),
    "from-existing": Flags.boolean({
      description: "Load credentials and config from existing local state",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(CredentialsAddCommand);
    const result = await runCredentialsAddAction({
      provider: args.provider,
      type: flags.type,
      credentials: flags.credential ?? [],
      configPairs: flags.config ?? [],
      fromExisting: flags["from-existing"] === true,
    });

    if (result.exitCode !== 0) {
      this.failWithLines(result.failureLines, result.exitCode);
      return;
    }
    for (const line of result.successLines) this.log(line);
  }
}
