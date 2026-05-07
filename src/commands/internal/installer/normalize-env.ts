// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { normalizeInstallerEnv } from "../../../lib/actions/installer-plan";

export default class InternalInstallerNormalizeEnvCommand extends Command {
  static hidden = true;
  static strict = true;
  static summary = "Internal: normalize installer environment values";
  static description = "Normalize installer ref and provider environment values without applying installation changes.";
  static usage = ["internal installer normalize-env [--json]"];
  static examples = ["<%= config.bin %> internal installer normalize-env --provider cloud --json"];
  static flags = {
    help: Flags.help({ char: "h" }),
    json: Flags.boolean({ description: "Print normalized values as JSON" }),
    "install-ref": Flags.string({ description: "NEMOCLAW_INSTALL_REF value" }),
    "install-tag": Flags.string({ description: "NEMOCLAW_INSTALL_TAG value" }),
    provider: Flags.string({ description: "NEMOCLAW_PROVIDER value" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InternalInstallerNormalizeEnvCommand);
    const normalized = normalizeInstallerEnv({
      NEMOCLAW_INSTALL_REF: flags["install-ref"] ?? process.env.NEMOCLAW_INSTALL_REF,
      NEMOCLAW_INSTALL_TAG: flags["install-tag"] ?? process.env.NEMOCLAW_INSTALL_TAG,
      NEMOCLAW_PROVIDER: flags.provider ?? process.env.NEMOCLAW_PROVIDER,
    });

    if (flags.json) console.log(JSON.stringify(normalized, null, 2));
    else console.log(`ref=${normalized.installRef} provider=${normalized.provider.normalized ?? ""}`);
  }
}
