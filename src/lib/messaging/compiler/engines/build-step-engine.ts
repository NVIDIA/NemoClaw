// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelHookOutputSpec,
  ChannelManifest,
  MessagingAgentId,
  SandboxMessagingBuildStepPlan,
} from "../../manifest";

export function planBuildSteps(
  manifest: ChannelManifest,
  agent: MessagingAgentId,
): SandboxMessagingBuildStepPlan[] {
  return manifest.hooks.flatMap((hook) => {
    if (hook.agents && !hook.agents.includes(agent)) return [];
    return (hook.outputs ?? [])
      .filter(isBuildStepOutput)
      .map((output) => ({
        channelId: manifest.id,
        kind: output.kind,
        hookId: hook.id,
        handler: hook.handler,
        outputId: output.id,
        required: output.required === true,
      }));
  });
}

function isBuildStepOutput(
  output: ChannelHookOutputSpec,
): output is ChannelHookOutputSpec & { readonly kind: "build-arg" | "build-file" } {
  return output.kind === "build-arg" || output.kind === "build-file";
}
