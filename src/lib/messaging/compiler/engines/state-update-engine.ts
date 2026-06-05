// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest, SandboxMessagingStateUpdatePlan } from "../../manifest";

export function planStateUpdates(manifest: ChannelManifest): SandboxMessagingStateUpdatePlan[] {
  const persistUpdates = Object.entries(manifest.state.persist ?? {}).map(
    ([stateKey, inputIds]) => ({
      channelId: manifest.id,
      kind: "persist-inputs" as const,
      stateKey,
      inputIds,
    }),
  );

  const hydrationUpdates = (manifest.state.rebuildHydration ?? []).map((hydration) => ({
    channelId: manifest.id,
    kind: "rebuild-hydration" as const,
    statePath: hydration.statePath,
    env: hydration.env,
  }));

  return [...persistUpdates, ...hydrationUpdates];
}
