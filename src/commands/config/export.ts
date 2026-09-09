// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import { renderCanonicalNemoClawConfig } from "../../lib/config/canonical";
import { ConfigExportInputError, runConfigExport } from "../../lib/config/export";
import { buildExportConfig } from "../../lib/config/export-builder";
import {
  LiveExportObservationError,
  observeLiveExportSource,
} from "../../lib/config/export-live-adapters";
import { publishExportFile, YamlExportOutputError } from "../../lib/config/output";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { isValidName } from "../../lib/sandbox-name-contract";
import { sandboxNameArg } from "../../lib/sandbox/command-support";

export default class ConfigExportCommand extends NemoClawCommand {
  static id = "config:export";
  static strict = true;
  static enableJsonFlag = true;
  static summary = "Export a sandbox to a NemoClaw configuration file";
  static description =
    "Export a secret-free configuration from the registered sandbox and its current state. The command does not change the sandbox.";
  static usage = ["config export <sandbox> --output <path|-> [--name <name>] [--force] [--json]"];
  static examples = [
    "<%= config.bin %> config export alpha --output nemoclaw.yaml",
    "<%= config.bin %> config export alpha --output -",
  ];
  static args = { sandboxName: sandboxNameArg };
  static flags = {
    output: Flags.string({
      char: "o",
      description: "Write YAML to this path on Linux. Use - on any supported host.",
      required: true,
    }),
    name: Flags.string({ description: "Set metadata.name in the exported document" }),
    force: Flags.boolean({
      description: "Replace an existing regular file; refuse symlinks and other file types",
      default: false,
    }),
    json: Flags.boolean({
      description: "Print the versioned JSON export result after writing the file",
      default: false,
    }),
  };
  static publicDisplay = [
    {
      usage: "nemoclaw config export <sandbox>",
      description: "Export a sandbox to a NemoClaw configuration file",
      flags: "--output <path|-> [--name <name>] [--force] [--json]",
      group: "Sandbox Management",
      scope: "global",
      order: 11.5,
    },
  ] as const;

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(ConfigExportCommand);
    const json = flags.json ?? false;
    const documentName = flags.name ?? args.sandboxName;
    if (!isValidName(documentName)) this.error("The config name is invalid.");
    if (flags.output !== "-" && process.platform !== "linux") {
      this.error("Config export file output currently requires Linux. Use --output - instead.");
    }
    try {
      return await runConfigExport(
        {
          sandboxName: args.sandboxName,
          documentName,
          output: flags.output,
          force: flags.force,
          json,
        },
        {
          observe: observeLiveExportSource,
          buildConfig: buildExportConfig,
          render: renderCanonicalNemoClawConfig,
          publish: publishExportFile,
          writeStdout: (yaml) => process.stdout.write(yaml),
        },
      );
    } catch (error) {
      if (error instanceof LiveExportObservationError) {
        this.error(
          [
            `Config export failed (${error.category}).`,
            ...error.findings.map((finding) => finding.diagnostic),
          ].join("\n"),
        );
      }
      if (error instanceof ConfigExportInputError || error instanceof YamlExportOutputError) {
        this.error(`Config export failed (${error.category}): ${error.message}`);
      }
      throw error;
    }
  }
}
