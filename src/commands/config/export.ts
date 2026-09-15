// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { Flags } from "@oclif/core";
import { formatConfigExportFailure } from "../../lib/cli/config-export-diagnostics";
import type { ConfigExportTarget } from "../../lib/actions/config/export";
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

  private exportTarget(output: string, force: boolean, json: boolean): ConfigExportTarget {
    if (json && output === "-") {
      this.error("--json cannot be used when --output is stdout (-).");
    }
    if (force && output === "-") {
      this.error("--force cannot be used when --output is stdout (-).");
    }
    if (output !== "-" && process.platform !== "linux") {
      this.error("Config export file output currently requires Linux. Use --output - instead.");
    }
    return output === "-" ? { kind: "stdout" } : { kind: "file", outputPath: output, force };
  }

  public async run(): Promise<unknown> {
    const { args, flags } = await this.parse(ConfigExportCommand);
    const json = this.jsonEnabled();
    const documentName = flags.name ?? args.sandboxName;
    const { isValidNemoClawConfigDocumentName, parseNemoClawConfigDocumentUid } =
      await import("../../lib/config/model");
    if (!isValidNemoClawConfigDocumentName(documentName)) this.error("The config name is invalid.");
    const target = this.exportTarget(flags.output, flags.force, json);
    const [
      { runConfigExport },
      { observeStableExportSource },
      { createLiveExportSnapshotReader },
      { publishExportFile },
    ] = await Promise.all([
      import("../../lib/actions/config/export"),
      import("../../lib/actions/config/observe-export-source"),
      import("../../lib/adapters/config/live-export-source"),
      import("../../lib/adapters/fs/config-export-file"),
    ]);
    const snapshotReader = createLiveExportSnapshotReader();
    const outcome = await runConfigExport(
      {
        sandboxName: args.sandboxName,
        documentName,
        target,
      },
      {
        observe: (sandboxName) => observeStableExportSource(sandboxName, snapshotReader),
        createDocumentUid: () => parseNemoClawConfigDocumentUid(randomUUID()),
        publish: publishExportFile,
        writeStdout: (yaml) =>
          new Promise<void>((resolve, reject) => {
            process.stdout.write(yaml, (error) => (error ? reject(error) : resolve()));
          }),
      },
    );
    if (!outcome.ok) this.error(formatConfigExportFailure(outcome.failure));
    const { completion } = outcome;
    return completion.kind === "file" ? completion.result : undefined;
  }
}
