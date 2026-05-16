// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import { resolveInstallRef } from "../../../lib/domain/installer/ref";

export default class InternalInstallerResolveReleaseTagCommand extends NemoClawCommand {
  static hidden = true;
  static strict = true;
  static summary = "Internal: resolve the installer release ref";
  static description = "Resolve the installer ref using the same precedence as install.sh.";
  static usage = ["internal installer resolve-release-tag [--json]"];
  static examples = ["<%= config.bin %> internal installer resolve-release-tag --install-ref v0.1.0"];
  static flags = {
    json: Flags.boolean({ description: "Print the resolved ref as JSON" }),
    "install-ref": Flags.string({ description: "NEMOCLAW_INSTALL_REF value" }),
    "install-tag": Flags.string({ description: "NEMOCLAW_INSTALL_TAG value" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InternalInstallerResolveReleaseTagCommand);
    const installRef = resolveInstallRef({
      NEMOCLAW_INSTALL_REF: flags["install-ref"] ?? process.env.NEMOCLAW_INSTALL_REF,
      NEMOCLAW_INSTALL_TAG: flags["install-tag"] ?? process.env.NEMOCLAW_INSTALL_TAG,
    });

    if (flags.json) this.logJson({ installRef });
    else console.log(installRef);
  }
}
