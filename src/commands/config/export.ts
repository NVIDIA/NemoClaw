// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { Flags } from "@oclif/core";
import { runConfigExport, type ConfigExportTarget } from "../../lib/config/export";
import { observeLiveExportSource } from "../../lib/config/export-live-adapters";
import {
  isValidNemoClawConfigDocumentName,
  parseNemoClawConfigDocumentUid,
} from "../../lib/config/model";
import { publishExportFile } from "../../lib/config/output";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
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
    const json = this.jsonEnabled();
    const documentName = flags.name ?? args.sandboxName;
    if (!isValidNemoClawConfigDocumentName(documentName)) this.error("The config name is invalid.");
    if (json && flags.output === "-") {
      this.error("--json cannot be used when --output is stdout (-).");
    }
    if (flags.force && flags.output === "-") {
      this.error("--force cannot be used when --output is stdout (-).");
    }
    if (flags.output !== "-" && process.platform !== "linux") {
      this.error("Config export file output currently requires Linux. Use --output - instead.");
    }
    const target: ConfigExportTarget =
      flags.output === "-"
        ? { kind: "stdout" }
        : { kind: "file", outputPath: flags.output, force: flags.force };
    const outcome = await runConfigExport(
      {
        sandboxName: args.sandboxName,
        documentName,
        target,
      },
      {
        observe: observeLiveExportSource,
        createDocumentUid: () => parseNemoClawConfigDocumentUid(randomUUID()),
        publish: publishExportFile,
        writeStdout: (yaml) =>
          new Promise<void>((resolve, reject) => {
            process.stdout.write(yaml, (error) => (error ? reject(error) : resolve()));
          }),
      },
    );
    if (!outcome.ok) {
      const { failure } = outcome;
      if (failure.kind === "observation") {
        const categories = [...new Set(failure.findings.map(({ category }) => category))];
        this.error(
          [
            `Config export failed (${categories.join(", ")}).`,
            ...failure.findings.map(({ diagnostic }) => diagnostic),
          ].join("\n"),
        );
      }
      this.error(`Config export failed (${failure.category}): ${failure.diagnostic}`);
    }
    const { completion } = outcome;
    return completion.kind === "file" ? completion.result : undefined;
  }
}
