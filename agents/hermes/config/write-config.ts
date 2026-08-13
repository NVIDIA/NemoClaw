// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HermesManagedPolicyV1 } from "./managed-policy.ts";
import {
  serializeHermesSwitchyardRelayToml,
  type HermesSwitchyardRouting,
} from "../../../src/lib/hermes-switchyard-routing.ts";
import { buildHermesUpstreamHeader } from "./upstream-header.ts";
import { toYaml } from "./yaml.ts";

export type WrittenHermesConfig = {
  configPath: string;
  envPath: string;
  envEntryCount: number;
  policyPath: string;
  relayPluginsPath: string | null;
};

export function writeHermesConfigFiles(
  config: Record<string, unknown>,
  envLines: string[],
  policy: HermesManagedPolicyV1,
  switchyardRouting: HermesSwitchyardRouting | null,
  homeDir: string = homedir(),
): WrittenHermesConfig {
  const configPath = join(homeDir, ".hermes", "config.yaml");
  writeFileSync(configPath, `${buildHermesUpstreamHeader(config)}${toYaml(config)}`);
  chmodSync(configPath, 0o600);

  const envPath = join(homeDir, ".hermes", ".env");
  writeFileSync(envPath, envLines.length > 0 ? `${envLines.join("\n")}\n` : "");
  chmodSync(envPath, 0o600);

  const policyPath = join(homeDir, ".hermes", "managed-policy.json");
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  chmodSync(policyPath, 0o600);

  const generatedRelayPluginsPath = join(homeDir, ".hermes", "relay-plugins.toml");
  let relayPluginsPath: string | null = null;
  if (switchyardRouting === null) {
    rmSync(generatedRelayPluginsPath, { force: true });
  } else {
    writeFileSync(generatedRelayPluginsPath, serializeHermesSwitchyardRelayToml(switchyardRouting));
    chmodSync(generatedRelayPluginsPath, 0o600);
    relayPluginsPath = generatedRelayPluginsPath;
  }

  return {
    configPath,
    envPath,
    envEntryCount: envLines.length,
    policyPath,
    relayPluginsPath,
  };
}
