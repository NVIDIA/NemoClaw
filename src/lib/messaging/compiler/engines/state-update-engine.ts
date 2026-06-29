// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest, SandboxMessagingStateUpdatePlan } from "../../manifest";

export function planStateUpdates(manifest: ChannelManifest): SandboxMessagingStateUpdatePlan[] {
  const persistUpdates = planPersistUpdates(manifest);
  const hydrationUpdates = planRebuildHydrationUpdates(manifest);
  return [...persistUpdates, ...hydrationUpdates];
}

function planPersistUpdates(manifest: ChannelManifest): SandboxMessagingStateUpdatePlan[] {
  const persistByStateKey = new Map<string, string[]>();

  for (const [stateKey, inputIds] of Object.entries(manifest.state.persist ?? {})) {
    for (const inputId of inputIds) {
      addPersistInput(persistByStateKey, stateKey, inputId);
    }
  }

  for (const input of manifest.inputs) {
    if (input.kind !== "config" || !input.statePath) continue;
    addPersistInput(persistByStateKey, stateKeyFromPath(input.statePath), input.id);
  }

  return [...persistByStateKey.entries()].map(([stateKey, inputIds]) => ({
    channelId: manifest.id,
    kind: "persist-inputs" as const,
    stateKey,
    inputIds,
  }));
}

function planRebuildHydrationUpdates(manifest: ChannelManifest): SandboxMessagingStateUpdatePlan[] {
  const hydrateEnvByStatePath = new Map<string, string>();

  for (const hydration of manifest.state.rebuildHydration ?? []) {
    hydrateEnvByStatePath.set(hydration.statePath, hydration.env);
  }

  for (const input of manifest.inputs) {
    if (input.kind !== "config" || !input.statePath || !input.envKey) continue;
    if (!hydrateEnvByStatePath.has(input.statePath)) {
      hydrateEnvByStatePath.set(input.statePath, input.envKey);
    }
  }

  return [...hydrateEnvByStatePath.entries()].map(([statePath, env]) => ({
    channelId: manifest.id,
    kind: "rebuild-hydration" as const,
    statePath,
    env,
  }));
}

function addPersistInput(
  persistByStateKey: Map<string, string[]>,
  stateKey: string,
  inputId: string,
): void {
  const inputIds = persistByStateKey.get(stateKey) ?? [];
  if (!inputIds.includes(inputId)) inputIds.push(inputId);
  persistByStateKey.set(stateKey, inputIds);
}

function stateKeyFromPath(statePath: string): string {
  return statePath.split(".", 1)[0] ?? statePath;
}
