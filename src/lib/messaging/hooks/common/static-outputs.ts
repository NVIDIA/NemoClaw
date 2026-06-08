// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../types";

export const COMMON_STATIC_OUTPUTS_HOOK_HANDLER_ID = "common.staticOutputs";

export function createStaticOutputsHook(): MessagingHookHandler {
  return (context) => {
    const outputs: Record<string, MessagingHookOutputMap[string]> = {};
    for (const output of context.outputDeclarations ?? []) {
      if (output.value === undefined) {
        if (output.required) {
          throw new Error(
            `Static output hook '${context.hookId}' missing required value '${output.id}'`,
          );
        }
        continue;
      }
      outputs[output.id] = {
        kind: output.kind,
        value: output.value,
      };
    }
    return { outputs };
  };
}

export function createStaticOutputsHookRegistration(): MessagingHookRegistration {
  return {
    id: COMMON_STATIC_OUTPUTS_HOOK_HANDLER_ID,
    handler: createStaticOutputsHook(),
  };
}
