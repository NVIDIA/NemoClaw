// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryModelsStore, type CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentModelConfig } from "nemo-fabric-adapter-contract";
import { LifecycleError } from "nemo-fabric-adapters-common";

/** Pi owns the model schema, defaults, and validation through its native loader. */
export async function loadConfiguredModel(
  selected: AgentModelConfig,
  credentials: CredentialStore,
) {
  const directory = await mkdtemp(join(tmpdir(), "nemoclaw-pi-model-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const metadata = selected.settings?.model_metadata;
    const modelsPath = join(directory, "models.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          [selected.provider]: {
            baseUrl: selected.base_url,
            ...(metadata === undefined
              ? {}
              : {
                  models: [
                    {
                      ...(metadata as object),
                      // The deployment owns identity and routing, not the opaque object.
                      id: selected.model,
                      baseUrl: selected.base_url,
                    },
                  ],
                }),
          },
        },
      }),
      { mode: 0o600 },
    );
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const error = modelRuntime.getError();
    if (error) throw new LifecycleError("pi_model_invalid", error);
    const model = modelRuntime.getModel(selected.provider, selected.model);
    if (!model)
      throw new LifecycleError(
        "pi_model_unknown",
        "The configured model is not in the Pi catalog; supply its native piModel configuration",
      );
    return { modelRuntime, model, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
