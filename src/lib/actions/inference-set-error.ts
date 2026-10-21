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

/** Reject an unverified selection after applying its existing compensation policy. */
export async function requireSuccessfulInferenceProbe(input: {
  probe: { ok: true } | { ok: false; detail: string };
  selectingNativeLocal: boolean;
  selectingNative: boolean;
  sandboxName: string;
  provider: string;
  model: string;
  previousProvider: string;
  previousModel: string;
  rollbackRoute: { provider: string; model: string } | null;
  restorePreviousInferenceSelection: () => Promise<string | null>;
}): Promise<void> {
  const {
    probe,
    selectingNativeLocal,
    selectingNative,
    sandboxName,
    provider,
    model,
    previousProvider,
    previousModel,
    rollbackRoute,
    restorePreviousInferenceSelection,
  } = input;
  if (probe.ok) return;
  if (selectingNativeLocal) {
    throw new InferenceSetError(
      `Native local inference verification failed for '${sandboxName}': ${probe.detail}. No new inference selection was committed.`,
    );
  }
  const restoreFailure = await restorePreviousInferenceSelection();
  if (restoreFailure) {
    throw new InferenceSetError(
      `Sandbox-side verification rejected provider '${provider}' / '${model}': ${probe.detail}. ` +
        `Failed to restore the previous OpenShell inference selection '${rollbackRoute?.provider ?? previousProvider}' / ` +
        `'${rollbackRoute?.model ?? previousModel}': ${restoreFailure}. Re-run onboarding before using this route.`,
    );
  }
  const recovery = inferenceProbeRecoveryMessage(
    selectingNative,
    previousProvider,
    previousModel,
    rollbackRoute,
  );
  throw new InferenceSetError(
    `Sandbox-side verification rejected provider '${provider}' / '${model}': ${probe.detail}. ${recovery}`,
  );
}
