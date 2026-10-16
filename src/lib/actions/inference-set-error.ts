// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export class InferenceSetError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "InferenceSetError";
  }
}

export function inferenceProbeRecoveryMessage(
  selectingNative: boolean,
  previousProvider: string,
  previousModel: string,
  rollbackRoute: { provider: string; model: string } | null,
): string {
  if (selectingNative)
    return `The previous inference selection '${previousProvider}' / '${previousModel}' was not changed.`;
  return `The previous OpenShell inference selection was restored to '${rollbackRoute?.provider ?? previousProvider}' / '${rollbackRoute?.model ?? previousModel}'.`;
}
