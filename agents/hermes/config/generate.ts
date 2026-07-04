// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type HermesBuildSettings, readHermesBuildSettings } from "./build-env.ts";
import { buildHermesConfig, finalizeHermesPlatformToolsets } from "./hermes-config.ts";
import { buildHermesEnvLines } from "./hermes-env.ts";
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
  written: WrittenHermesConfig;
};

/** Generate the immutable Hermes config files from an explicit build environment. */
export function generateHermesConfig({
  env,
  scriptDir,
  homeDir,
  log = console.log,
}: GenerateHermesConfigOptions): GeneratedHermesConfig {
  const settings = readHermesBuildSettings(env);
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

  const config = buildHermesConfig(settings, env);
  const envLines = buildHermesEnvLines(settings, env);
  finalizeHermesPlatformToolsets(config, settings);
  const written = writeHermesConfigFiles(config, envLines, homeDir);

  log(`[config] Wrote ${written.configPath} (model=${settings.model}, provider=custom)`);
  log(`[config] Wrote ${written.envPath} (${written.envEntryCount} entries)`);

  return { settings, config, envLines, written };
}
