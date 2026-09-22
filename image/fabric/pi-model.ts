// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryModelsStore, type CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentModelConfig } from "nemo-fabric-adapter-contract";
import { LifecycleError } from "nemo-fabric-adapters-common";

/** Pi owns model validation; route-specific providers keep endpoints and keys separate. */
export async function loadConfiguredModel(
  selected: AgentModelConfig,
  credentials: CredentialStore,
  choices?: Record<string, AgentModelConfig>,
) {
  const directory = await mkdtemp(join(tmpdir(), "nemoclaw-pi-model-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const options = { credentials, allowModelNetwork: false, refreshOnCreate: false };
    const catalog = await ModelRuntime.create({ ...options, modelsPath: null });
    const entries = Object.entries(choices ?? { default: selected });
    const providers = Object.fromEntries(
      entries.map(([alias, config]) => {
        const native = config.settings?.model_metadata;
        const known =
          native === undefined ? catalog.getModel(config.provider, config.model) : undefined;
        if (native === undefined && !known)
          throw new LifecycleError(
            "pi_model_unknown",
            "The configured model is not in the Pi catalog; supply its native piModel configuration",
          );
        const metadata =
          native ??
          Object.fromEntries(Object.entries(known!).filter(([key]) => key !== "provider"));
        return [
          choices ? `nemoclaw-${alias.replaceAll("_", "-")}` : config.provider,
          {
            baseUrl: config.base_url ?? known?.baseUrl,
            models: [
              {
                ...(metadata as object),
                id: config.model,
                baseUrl: config.base_url ?? known?.baseUrl,
              },
            ],
          },
        ];
      }),
    );
    const modelsPath = join(directory, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers }), { mode: 0o600 });
    const modelRuntime = await ModelRuntime.create({
      ...options,
      modelsPath,
      modelsStore: new InMemoryModelsStore(),
    });
    const error = modelRuntime.getError();
    if (error) throw new LifecycleError("pi_model_invalid", error);
    const models = Object.fromEntries(
      entries.map(([alias, config]) => {
        const model = modelRuntime.getModel(
          choices ? `nemoclaw-${alias.replaceAll("_", "-")}` : config.provider,
          config.model,
        );
        if (!model)
          throw new LifecycleError("pi_model_unknown", "The configured Pi model is unavailable");
        return [alias, model];
      }),
    );
    const model = models.default;
    if (!model) throw new LifecycleError("pi_model_unknown", "Pi requires a default model");
    return { modelRuntime, model, models, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
