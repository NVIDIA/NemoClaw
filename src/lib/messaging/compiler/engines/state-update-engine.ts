// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest, SandboxMessagingStateUpdatePlan } from "../../manifest";

export function planStateUpdates(manifest: ChannelManifest): SandboxMessagingStateUpdatePlan[] {
  const inputIdsByStateKey = new Map<string, string[]>();
  const hydrationUpdates: SandboxMessagingStateUpdatePlan[] = [];

  for (const input of manifest.inputs) {
    if (input.kind !== "config" || !input.statePath) continue;

    const stateKey = stateKeyFromPath(input.statePath);
    inputIdsByStateKey.set(stateKey, [...(inputIdsByStateKey.get(stateKey) ?? []), input.id]);
    if (input.envKey) {
      hydrationUpdates.push({
        channelId: manifest.id,
        kind: "rebuild-hydration",
        statePath: input.statePath,
        env: input.envKey,
      });
    }
  }

  const persistUpdates: SandboxMessagingStateUpdatePlan[] = [...inputIdsByStateKey].map(
    ([stateKey, inputIds]) => ({
      channelId: manifest.id,
      kind: "persist-inputs",
      stateKey,
      inputIds,
    }),
  );

  return [...persistUpdates, ...hydrationUpdates];
}

function stateKeyFromPath(statePath: string): string {
  return statePath.split(".", 1)[0] || statePath;
}
