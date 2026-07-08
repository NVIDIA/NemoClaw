// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { runAgentsApply } from "../../../lib/actions/sandbox/agents/apply";
import { CLI_NAME } from "../../../lib/cli/branding";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

function printApplyHelp(): void {
  console.log("");
  console.log(
    `  Usage: ${CLI_NAME} <name> agents apply -f <agents.yaml> [--yes] [--non-interactive]`,
  );
  console.log("");
  console.log(
    `  Reconcile the live sandbox roster against a declarative agents manifest. The verb`,
  );
  console.log(
    "  adds missing secondary agents and deletes orphan ones via `openclaw agents add|delete`.",
  );
  console.log(
    "  Per-agent `model`, `subagents.*`, top-level `defaults`, and `main` overrides require a",
  );
  console.log(
    "  sandbox rebuild and are reported as warnings; rerun `nemoclaw onboard --agents <file>",
  );
  console.log("  --recreate-sandbox` to bake them.");
  console.log("");
  console.log("  Flags:");
  console.log("    -f, --file <agents.yaml>   Path to the manifest (required).");
  console.log(
    "    --yes                      Confirm roster changes without an interactive prompt.",
  );
  console.log("    --non-interactive          Fail fast if `--yes` is not supplied.");
  console.log("");
}

export default class SandboxAgentsApplyCommand extends NemoClawCommand {
  static id = "sandbox:agents:apply";
  static strict = false;
  static summary = "Reconcile a sandbox's OpenClaw agents against a declarative manifest";
  static description =
    "Read an `agents.yaml` manifest and apply roster diffs (add/delete) to the live sandbox via `openclaw agents add|delete`. Per-agent config fields (`model`, `subagents.*`, top-level `defaults`, `main`) need a rebuild and are surfaced as warnings instead of silent no-ops.";
  static usage = ["<name> agents apply -f <agents.yaml> [--yes] [--non-interactive]"];
  static examples = [
    "<%= config.bin %> sandbox agents apply alpha -f ./agents.yaml",
    "<%= config.bin %> sandbox agents apply alpha -f ./agents.yaml --yes",
  ];

  public async run(): Promise<void> {
    this.parsed = true;
    const [sandboxName, ...rest] = this.argv;
    if (!sandboxName || sandboxName === "--help" || sandboxName === "-h") {
      printApplyHelp();
      return;
    }
    let manifestPath: string | undefined;
    let yes = false;
    let nonInteractive = false;
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index];
      if (arg === "--help" || arg === "-h") {
        printApplyHelp();
        return;
      }
      if (arg === "-f" || arg === "--file") {
        const value = rest[index + 1];
        if (typeof value !== "string" || !value || value.startsWith("--")) {
          console.error("  -f/--file requires a path to a YAML manifest");
          printApplyHelp();
          process.exit(1);
        }
        manifestPath = value;
        index += 1;
        continue;
      }
      if (arg === "--yes" || arg === "-y") {
        yes = true;
        continue;
      }
      if (arg === "--non-interactive") {
        nonInteractive = true;
        continue;
      }
      console.error(`  Unknown flag: ${arg}`);
      printApplyHelp();
      process.exit(1);
    }
    if (!manifestPath) {
      console.error("  -f/--file <agents.yaml> is required");
      printApplyHelp();
      process.exit(1);
    }
    await runAgentsApply({
      sandboxName,
      manifestPath: path.resolve(manifestPath),
      yes,
      nonInteractive,
    });
  }
}
