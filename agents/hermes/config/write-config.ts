// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { toYaml } from "./yaml.ts";

export type WrittenHermesConfig = {
  configPath: string;
  envPath: string;
  envEntryCount: number;
};

export function writeHermesConfigFiles(
  config: Record<string, unknown>,
  envLines: string[],
  homeDir: string = homedir(),
): WrittenHermesConfig {
  const configPath = join(homeDir, ".hermes", "config.yaml");
  writeFileSync(configPath, toYaml(config));
  chmodSync(configPath, 0o600);

  const envPath = join(homeDir, ".hermes", ".env");
  writeFileSync(envPath, envLines.length > 0 ? `${envLines.join("\n")}\n` : "");
  chmodSync(envPath, 0o600);

  return {
    configPath,
    envPath,
    envEntryCount: envLines.length,
  };
}
