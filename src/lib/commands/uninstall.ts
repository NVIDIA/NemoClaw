// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { Command, Flags } from "@oclif/core";

import { getVersion } from "../version";
import { buildVersionedUninstallUrl, runUninstallCommand } from "../uninstall-command";

export default class UninstallCliCommand extends Command {
  static id = "uninstall";
  static strict = false;
  static summary = "Run uninstall.sh";
  static description = "Run the local uninstall.sh script; remote fallback is disabled.";
  static usage = ["uninstall [flags]"];
  static examples = ["<%= config.bin %> uninstall --yes"];
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    this.parsed = true;
    runUninstallCommand({
      args: this.argv,
      rootDir: this.config.root,
      currentDir: __dirname,
      remoteScriptUrl: buildVersionedUninstallUrl(getVersion()),
      env: process.env,
      spawnSyncImpl: spawnSync,
      log: console.log,
      error: console.error,
      exit: /* v8 ignore next -- uninstall exit behavior is covered by uninstall command tests. */ (code: number) => process.exit(code),
    });
  }
}
