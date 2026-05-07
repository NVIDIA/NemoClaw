// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { buildInstallerPlan } from "../../../lib/actions/installer-plan";

export default class InternalInstallerPlanCommand extends Command {
  static hidden = true;
  static strict = true;
  static summary = "Internal: build the NemoClaw installer plan";
  static description = "Build a deterministic installer plan from environment and probe inputs without applying it.";
  static usage = ["internal installer plan [--json]"];
  static examples = ["<%= config.bin %> internal installer plan --json --provider nim --install-ref v0.1.0"];
  static flags = {
    help: Flags.help({ char: "h" }),
    json: Flags.boolean({ description: "Print the installer plan as JSON" }),
    "install-ref": Flags.string({ description: "Install ref override" }),
    "install-tag": Flags.string({ description: "Install tag fallback" }),
    "git-describe-version": Flags.string({ description: "git describe version fallback", hidden: true }),
    "node-version": Flags.string({ description: "Detected Node.js version" }),
    "npm-prefix": Flags.string({ description: "Detected npm prefix" }),
    "npm-version": Flags.string({ description: "Detected npm version" }),
    "package-json-version": Flags.string({ description: "package.json version fallback", hidden: true }),
    provider: Flags.string({ description: "Installer provider value" }),
    "stamped-version": Flags.string({ description: "Stamped .version fallback", hidden: true }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InternalInstallerPlanCommand);
    const plan = buildInstallerPlan({
      env: {
        ...process.env,
        NEMOCLAW_INSTALL_REF: flags["install-ref"] ?? process.env.NEMOCLAW_INSTALL_REF,
        NEMOCLAW_INSTALL_TAG: flags["install-tag"] ?? process.env.NEMOCLAW_INSTALL_TAG,
        NEMOCLAW_PROVIDER: flags.provider ?? process.env.NEMOCLAW_PROVIDER,
      },
      gitDescribeVersion: flags["git-describe-version"],
      nodeVersion: flags["node-version"],
      npmPrefix: flags["npm-prefix"],
      npmVersion: flags["npm-version"],
      packageJsonVersion: flags["package-json-version"],
      stampedVersion: flags["stamped-version"],
    });

    if (flags.json) console.log(JSON.stringify(plan, null, 2));
    else console.log(`Installer plan: ref '${plan.installRef}', version '${plan.installerVersion}'`);
  }
}
