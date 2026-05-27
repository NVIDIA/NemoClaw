// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import { initSecretsEnvFile } from "../../lib/credentials/secrets-env";

export default class CredentialsInitSecretsCommand extends NemoClawCommand {
  static id = "credentials:init-secrets";
  static strict = true;
  static summary = "Create a local secrets.env file for API keys";
  static description =
    "Create ~/.nemoclaw/secrets.env (mode 0600) outside any git repo for storing API keys.";
  static usage = ["credentials init-secrets"];
  static examples = ["<%= config.bin %> credentials init-secrets"];
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(CredentialsInitSecretsCommand);
    const result = initSecretsEnvFile();
    if (!result.ok) {
      this.failWithLines([`  Could not create secrets file: ${result.message}`]);
      return;
    }
    if (result.created) {
      this.log("");
      this.log(`  Created ${result.path}`);
      this.log("  Edit that file with your API keys (NVIDIA_API_KEY, NVIDIA_INFERENCE_HUB_API_KEY, etc.).");
      this.log("  It stays in your home directory and is never committed to git.");
      this.log("");
      return;
    }
    this.log("");
    this.log(`  Secrets file already exists: ${result.path}`);
    this.log("  Edit it directly; NemoClaw loads it automatically on onboard and rebuild.");
    this.log("");
  }
}
