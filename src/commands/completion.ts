// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { runCompletionAction, runCompletionSandboxNamesAction } from "../lib/actions/completion";
import { NemoClawCommand } from "../lib/cli/nemoclaw-oclif-command";

export default class CompletionCommand extends NemoClawCommand {
  static id = "completion";
  static strict = true;
  static summary = "Generate shell completion script";
  static description =
    "Output a shell completion script for nemoclaw. Source it in your shell profile to enable tab completion for commands, flags, and sandbox names.";
  static usage = ["completion [bash|zsh|fish]"];
  static examples = [
    "# Bash (add to ~/.bashrc or ~/.bash_profile):",
    "source <(<%= config.bin %> completion bash)",
    "",
    "# Zsh (add to ~/.zshrc):",
    "source <(<%= config.bin %> completion zsh)",
    "",
    "# Fish (install permanently):",
    "<%= config.bin %> completion fish > ~/.config/fish/completions/<%= config.bin %>.fish",
  ];

  static args = {
    shell: Args.string({
      description: "Target shell: bash, zsh, or fish. Auto-detected from $SHELL when omitted.",
      options: ["bash", "zsh", "fish"],
      required: false,
    }),
  };
  static flags = {
    "list-sandbox-names": Flags.boolean({
      description: "List registered sandbox names for shell completion",
      hidden: true,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(CompletionCommand);
    if (flags["list-sandbox-names"]) {
      runCompletionSandboxNamesAction();
      return;
    }
    runCompletionAction(args.shell, this.config.commands, this.config.bin);
  }
}
