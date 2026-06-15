// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest, SandboxMessagingHealthCheckPlan } from "../../manifest";

export function planHealthChecks(manifest: ChannelManifest): SandboxMessagingHealthCheckPlan[] {
  const hookIds = manifest.hooks
    .filter((hook) => hook.phase === "health-check")
    .map((hook) => hook.id);
  if (hookIds.length === 0) return [];
  return [
    {
      channelId: manifest.id,
      phase: "health-check",
      requiredBefore: "lifecycle-success",
      hookIds,
    },
  ];
}
