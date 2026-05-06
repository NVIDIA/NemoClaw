// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Generate Hermes config.yaml and .env from NemoClaw build-arg env vars.
//
// Called at Docker image build time. Reads NEMOCLAW_* env vars and writes:
//   ~/.hermes/config.yaml  — Hermes configuration (immutable at runtime)
//   ~/.hermes/.env         — Messaging token placeholders (immutable at runtime)
//
// Sets what's required for Hermes to run inside OpenShell:
//   - Model and inference endpoint (custom provider pointing at inference.local)
//   - API server on internal port (socat forwards to public port)
//   - Messaging platform tokens (if configured during onboard)
//   - Agent defaults (terminal, memory, skills, display)

import { readHermesBuildSettings } from "./config/build-env.ts";
import { buildHermesConfig } from "./config/hermes-config.ts";
import { buildMessagingEnvLines } from "./config/messaging-config.ts";
import { discoverModelSpecificSetups } from "./config/model-specific-setup.ts";
import { writeHermesConfigFiles } from "./config/write-config.ts";

function main(): void {
  const settings = readHermesBuildSettings(process.env);

  discoverModelSpecificSetups(
    "hermes",
    {
      model: settings.model,
      providerKey: settings.providerKey,
      inferenceApi: settings.inferenceApi,
      baseUrl: settings.baseUrl,
    },
    {
      env: process.env,
      scriptDir: import.meta.dirname,
    },
  );

  const config = buildHermesConfig(settings);
  const envLines = buildMessagingEnvLines(
    settings.messaging.enabledChannels,
    settings.messaging.allowedIds,
    settings.messaging.discordGuilds,
  );
  const written = writeHermesConfigFiles(config, envLines);

  console.log(`[config] Wrote ${written.configPath} (model=${settings.model}, provider=custom)`);
  console.log(`[config] Wrote ${written.envPath} (${written.envEntryCount} entries)`);
}

main();
