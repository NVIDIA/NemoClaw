// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapter covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

import { CLI_DISPLAY_NAME, CLI_NAME } from "./branding";
import { prompt as askPrompt } from "./credentials";
import { recoverNamedGatewayRuntime, runOpenshellProviderCommand } from "./global-cli-actions";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "./openshell-timeouts";

// Suffixes that mark per-sandbox messaging integrations in the gateway's
// provider list. These are managed by `channels`, not `credentials`.
const BRIDGE_PROVIDER_SUFFIXES: readonly string[] = [
  "-telegram-bridge",
  "-discord-bridge",
  "-slack-bridge",
  "-slack-app",
];

function isBridgeProviderName(name: string): boolean {
  return BRIDGE_PROVIDER_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function printCredentialsUsage(log: (message?: string) => void = console.log): void {
  log("");
  log(`  Usage: ${CLI_NAME} credentials <subcommand>`);
  log("");
  log("  Subcommands:");
  log("    list                  List provider credentials registered with the OpenShell gateway");
  log("    reset <PROVIDER> [--yes]   Remove a provider credential so onboard re-prompts");
  log("");
  log("  Credentials live in the OpenShell gateway. Inspect with `openshell provider list`.");
  log("  Nothing is persisted to host disk; deploy/non-onboard commands read from env vars.");
  log("");
}

async function recoverGatewayOrExit(kind: "query" | "reach"): Promise<void> {
  const recovery = await recoverNamedGatewayRuntime();
  if (recovery.recovered) return;

  if (kind === "query") {
    console.error(`  Could not query the ${CLI_DISPLAY_NAME} OpenShell gateway. Is it running?`);
  } else {
    console.error(`  Could not reach the ${CLI_DISPLAY_NAME} OpenShell gateway. Is it running?`);
  }
  console.error(`  Run 'openshell gateway start --name nemoclaw' or '${CLI_NAME} onboard' first.`);
  process.exit(1);
}

export class CredentialsCommand extends Command {
  static id = "credentials";
  static strict = true;
  static summary = "Manage provider credentials";
  static description =
    "List or reset provider credentials registered with the OpenShell gateway.";
  static usage = ["credentials <list|reset>"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(CredentialsCommand);
    printCredentialsUsage(this.log.bind(this));
  }
}

export class CredentialsListCommand extends Command {
  static id = "credentials:list";
  static strict = true;
  static summary = "List stored credential providers";
  static description = "List provider credentials registered with the OpenShell gateway.";
  static usage = ["credentials list"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(CredentialsListCommand);
    await recoverGatewayOrExit("query");

    const result = runOpenshellProviderCommand(["provider", "list", "--names"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      console.error("  Could not query OpenShell gateway. Is it running?");
      console.error(`  Run 'openshell gateway start --name nemoclaw' or '${CLI_NAME} onboard' first.`);
      process.exit(1);
    }

    const allNames = String(result.stdout || "")
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const credentialNames = allNames.filter((name) => !isBridgeProviderName(name)).sort();
    const bridgeNames = allNames.filter((name) => isBridgeProviderName(name));

    if (credentialNames.length === 0) {
      this.log("  No provider credentials registered.");
    } else {
      this.log("  Providers registered with the OpenShell gateway:");
      for (const name of credentialNames) {
        this.log(`    ${name}`);
      }
    }
    if (bridgeNames.length > 0) {
      this.log("");
      this.log(`  ${String(bridgeNames.length)} per-sandbox messaging bridge(s) are also registered.`);
      this.log(`  Manage those with \`${CLI_NAME} <sandbox> channels list/remove/stop\` — not this command.`);
    }
  }
}

export class CredentialsResetCommand extends Command {
  static id = "credentials:reset";
  static strict = true;
  static summary = "Remove a provider credential";
  static description = "Remove a provider credential so onboard re-prompts for it.";
  static usage = ["credentials reset <PROVIDER> [--yes]"];
  static args = {
    provider: Args.string({
      name: "PROVIDER",
      description: "OpenShell provider name",
      required: false,
    }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    yes: Flags.boolean({ char: "y", description: "Skip the confirmation prompt" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(CredentialsResetCommand);
    const key = args.provider;

    if (!key || key.startsWith("-")) {
      console.error(`  Usage: ${CLI_NAME} credentials reset <PROVIDER> [--yes]`);
      console.error(`  PROVIDER is an OpenShell provider name. Run '${CLI_NAME} credentials list' first.`);
      process.exit(1);
    }

    if (isBridgeProviderName(key)) {
      console.error(`  '${key}' is a per-sandbox messaging bridge, not a credential.`);
      console.error(
        `  Use \`${CLI_NAME} <sandbox> channels remove <telegram|discord|slack>\` to retire`,
      );
      console.error("  the integration (it tears down the bridge provider and rebuilds the sandbox),");
      console.error(`  or \`${CLI_NAME} <sandbox> channels stop <…>\` to pause it without clearing tokens.`);
      process.exit(1);
    }

    if (!flags.yes) {
      const answer = (await askPrompt(`  Remove provider '${key}' from the OpenShell gateway? [y/N]: `))
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        this.log("  Cancelled.");
        return;
      }
    }

    await recoverGatewayOrExit("reach");

    const result = runOpenshellProviderCommand(["provider", "delete", key], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    if (result.status === 0) {
      this.log(`  Removed provider '${key}' from the OpenShell gateway.`);
      this.log(`  Re-run '${CLI_NAME} onboard' to enter a new value.`);
      return;
    }

    console.error(`  Could not remove provider '${key}'.`);
    if (/^[A-Z][A-Z0-9_]+$/.test(key)) {
      console.error("");
      console.error(`  '${key}' looks like a credential env variable name.`);
      console.error("  As of this release, 'credentials reset' takes an OpenShell");
      console.error(`  provider name. Run '${CLI_NAME} credentials list' to see the`);
      console.error("  registered providers, then retry with one of those names.");
    }
    const stderr = String(result.stderr || "").trim();
    if (stderr) console.error(`  ${stderr}`);
    process.exit(1);
  }
}
