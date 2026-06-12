// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookOutputMap } from "../../hooks";
import { MessagingHookRegistry, runMessagingHook } from "../../hooks";
import type {
  ChannelHookOutputSpec,
  ChannelManifest,
  MessagingAgentId,
  MessagingSerializableValue,
  SandboxMessagingBuildStepPlan,
  SandboxMessagingChannelPlan,
  SandboxMessagingCredentialBindingPlan,
} from "../../manifest";

export async function planBuildSteps(
  manifest: ChannelManifest,
  agent: MessagingAgentId,
  channel: SandboxMessagingChannelPlan | undefined,
  credentialBindings: readonly SandboxMessagingCredentialBindingPlan[],
  hooks: MessagingHookRegistry,
): Promise<SandboxMessagingBuildStepPlan[]> {
  const steps: SandboxMessagingBuildStepPlan[] = [];
  for (const hook of manifest.hooks) {
    if (hook.agents && !hook.agents.includes(agent)) continue;
    const buildOutputs = (hook.outputs ?? []).filter(isBuildStepOutput);
    if (buildOutputs.length === 0) continue;

    let hookOutputs: MessagingHookOutputMap = {};
    if (channel?.active) {
      const result = await runMessagingHook(hook, hooks, {
        channelId: manifest.id,
        inputs: selectHookInputs(buildHookInputMap(channel, credentialBindings), hook.inputs),
      });
      hookOutputs = result.outputs;
    }

    for (const output of buildOutputs) {
      const value = hookOutputs[output.id]?.value;
      steps.push({
        channelId: manifest.id,
        kind: output.kind,
        hookId: hook.id,
        handler: hook.handler,
        outputId: output.id,
        required: output.required === true,
        ...(value !== undefined ? { value } : {}),
      });
    }
  }
  return steps;
}

function isBuildStepOutput(output: ChannelHookOutputSpec): output is ChannelHookOutputSpec & {
  readonly kind: "build-arg" | "build-file" | "package-install";
} {
  return (
    output.kind === "build-arg" || output.kind === "build-file" || output.kind === "package-install"
  );
}

function buildHookInputMap(
  channel: SandboxMessagingChannelPlan,
  credentialBindings: readonly SandboxMessagingCredentialBindingPlan[],
): Record<string, MessagingSerializableValue> {
  const inputs: Record<string, MessagingSerializableValue> = {};
  for (const input of channel.inputs) {
    if (input.value === undefined) continue;
    inputs[input.inputId] = input.value;
    if (input.statePath) inputs[input.statePath] = input.value;
  }
  for (const credential of credentialBindings) {
    if (credential.channelId !== channel.channelId) continue;
    inputs[`credential.${credential.credentialId}.placeholder`] = credential.placeholder;
  }
  return inputs;
}

function selectHookInputs(
  inputs: Record<string, MessagingSerializableValue>,
  inputKeys: readonly string[] | undefined,
): Record<string, MessagingSerializableValue> | undefined {
  if (!inputKeys || inputKeys.length === 0) return inputs;
  return Object.fromEntries(
    inputKeys
      .filter((inputKey) => Object.hasOwn(inputs, inputKey))
      .map((inputKey) => [inputKey, inputs[inputKey] as MessagingSerializableValue]),
  );
}
