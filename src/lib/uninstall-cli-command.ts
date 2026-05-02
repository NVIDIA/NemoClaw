// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapter covered through CLI integration tests. */

import { spawnSync } from "node:child_process";

import { Command } from "@oclif/core";

import { getVersion } from "./version";
import { buildVersionedUninstallUrl, runUninstallCommand } from "./uninstall-command";

export default class UninstallCliCommand extends Command {
  static id = "uninstall";
  static strict = false;
  static summary = "Run uninstall.sh";
  static description = "Run the local uninstall.sh script; remote fallback is disabled.";
  static usage = ["uninstall [flags]"];

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
      exit: (code: number) => process.exit(code),
    });
  }
}
