// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { runOpenshellProviderCommand } from "../../lib/actions/global";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../lib/adapters/openshell/timeouts";
import { CLI_NAME } from "../../lib/cli/branding";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { isBridgeProviderName, recoverGatewayOrExit } from "../../lib/credentials/command-support";

export default class CredentialsAddCommand extends NemoClawCommand {
  static id = "credentials:add";
  static strict = true;
  static summary = "Register a provider credential";
  static description =
    "Register a provider credential with the OpenShell gateway so workloads in NemoClaw sandboxes can authenticate to the corresponding endpoint without holding the raw secret.";
  static usage = [
    "credentials add <PROVIDER> --type <TYPE> [--credential KEY[=VALUE]] [--config K=V] [--from-existing]",
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
      description: "Credential pair (KEY=VALUE) or env lookup key (KEY). Repeatable.",
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
    const provider = args.provider;
    const credentials = flags.credential ?? [];
    const config = flags.config ?? [];
    const fromExisting = flags["from-existing"];

    if (isBridgeProviderName(provider)) {
      this.failWithLines([
        `  '${provider}' is a per-sandbox messaging bridge, not a credential.`,
        `  Use \`${CLI_NAME} <sandbox> channels add <channel>\` to attach a messaging integration`,
        "  (it provisions the bridge provider and rebuilds the sandbox).",
      ]);
      return;
    }

    if (fromExisting && credentials.length > 0) {
      this.failWithLines(["  --from-existing cannot be combined with --credential."]);
      return;
    }
    if (!fromExisting && credentials.length === 0) {
      this.failWithLines([
        "  At least one --credential KEY[=VALUE] or --from-existing is required.",
      ]);
      return;
    }

    if (!(await recoverGatewayOrExit("reach", (lines) => this.failWithLines(lines)))) return;

    const openshellArgs: string[] = [
      "provider",
      "create",
      "--name",
      provider,
      "--type",
      flags.type,
    ];
    if (fromExisting) {
      openshellArgs.push("--from-existing");
    } else {
      for (const credential of credentials) {
        openshellArgs.push("--credential", credential);
      }
    }
    for (const configPair of config) {
      openshellArgs.push("--config", configPair);
    }

    const result = runOpenshellProviderCommand(openshellArgs, {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });

    if (result.status === 0) {
      this.log(`  Registered provider '${provider}' with the OpenShell gateway.`);
      this.log(`  Verify with '${CLI_NAME} credentials list'.`);
      return;
    }

    const stderr = String(result.stderr || "").trim();
    const lines = [`  Could not register provider '${provider}'.`];
    if (/already exists/i.test(stderr)) {
      lines.push(
        "",
        `  '${provider}' is already registered.`,
        `  Run '${CLI_NAME} credentials reset ${provider} --yes' first if you need to replace it.`,
      );
    } else if (stderr) {
      lines.push(`  ${stderr}`);
    }
    this.failWithLines(lines);
  }
}
