// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HermesManagedPolicyV3 } from "./managed-policy.ts";
import {
  HERMES_RELAY_PLUGIN_STATE_STAGING_FILE,
  HERMES_RELAY_PLUGINS_STAGING_FILE,
  HERMES_SWITCHYARD_DEPLOYMENT_STAGING_FILE,
  type SerializedHermesSwitchyardRouting,
} from "../../../src/lib/hermes-switchyard-routing.ts";
import { buildHermesUpstreamHeader } from "./upstream-header.ts";
import { toYaml } from "./yaml.ts";

export type WrittenHermesConfig = {
  configPath: string;
  envPath: string;
  envEntryCount: number;
  policyPath: string;
  relayPluginStatePath: string | null;
  relayPluginsPath: string | null;
  switchyardDeploymentPath: string | null;
};

export function writeHermesConfigFiles(
  config: Record<string, unknown>,
  envLines: string[],
  policy: HermesManagedPolicyV3,
  switchyardFiles: SerializedHermesSwitchyardRouting | null,
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

  const relayPluginsPath = join(homeDir, ".hermes", HERMES_RELAY_PLUGINS_STAGING_FILE);
  const relayPluginStatePath = join(homeDir, ".hermes", HERMES_RELAY_PLUGIN_STATE_STAGING_FILE);
  const switchyardDeploymentPath = join(
    homeDir,
    ".hermes",
    HERMES_SWITCHYARD_DEPLOYMENT_STAGING_FILE,
  );
  if (switchyardFiles) {
    writeFileSync(relayPluginsPath, switchyardFiles.relayPluginsToml);
    chmodSync(relayPluginsPath, 0o600);
    writeFileSync(relayPluginStatePath, switchyardFiles.relayPluginStateJson);
    chmodSync(relayPluginStatePath, 0o600);
    writeFileSync(switchyardDeploymentPath, switchyardFiles.switchyardDeploymentToml);
    chmodSync(switchyardDeploymentPath, 0o600);
  } else {
    rmSync(relayPluginsPath, { force: true });
    rmSync(relayPluginStatePath, { force: true });
    rmSync(switchyardDeploymentPath, { force: true });
  }

  return {
    configPath,
    envPath,
    envEntryCount: envLines.length,
    policyPath,
    relayPluginStatePath: switchyardFiles ? relayPluginStatePath : null,
    relayPluginsPath: switchyardFiles ? relayPluginsPath : null,
    switchyardDeploymentPath: switchyardFiles ? switchyardDeploymentPath : null,
  };
}
