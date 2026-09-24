// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type HermesBuildSettings, readHermesBuildSettings } from "./build-env.ts";
import {
  buildHermesManagedPolicy,
  finalizeHermesPlatformToolsets,
  type HermesManagedPolicyV1,
} from "./managed-policy.ts";
import { discoverModelSpecificSetups } from "./model-specific-setup.ts";
import { type WrittenHermesConfig, writeHermesConfigFiles } from "./write-config.ts";

export type GenerateHermesConfigOptions = {
  env: NodeJS.ProcessEnv;
  scriptDir: string;
  homeDir?: string;
  log?: (message: string) => void;
};

export type GeneratedHermesConfig = {
  settings: HermesBuildSettings;
  config: Record<string, unknown>;
  envLines: string[];
  policy: HermesManagedPolicyV1;
  written: WrittenHermesConfig;
};

/** Generate the initial mutable Hermes config files from an explicit build environment. */
export function generateHermesConfig({
  env,
  scriptDir,
  homeDir,
  log = console.log,
}: GenerateHermesConfigOptions): GeneratedHermesConfig {
  const settings = readHermesBuildSettings(env);
  if (settings.model !== null)
    discoverModelSpecificSetups(
      "hermes",
      {
        model: settings.model,
        providerKey: settings.providerKey,
        inferenceApi: settings.inferenceApi,
        baseUrl: settings.baseUrl,
      },
      { env, scriptDir },
    );

  const policy = buildHermesManagedPolicy(settings, env);
  const config = policy.config;
  const envLines = policy.env_lines;
  finalizeHermesPlatformToolsets(config, settings);
  const written = writeHermesConfigFiles(config, envLines, policy, homeDir);

  log(
    settings.model === null
      ? `[config] Wrote ${written.configPath} (inference not configured)`
      : `[config] Wrote ${written.configPath} (model=${settings.model}, provider=custom)`,
  );
  log(`[config] Wrote ${written.envPath} (${written.envEntryCount} entries)`);
  log(`[config] Wrote ${written.policyPath} (schema=${policy.schema_version})`);

  return { settings, config, envLines, policy, written };
}
