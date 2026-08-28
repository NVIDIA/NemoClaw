// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HermesPortableOllamaRecoveryError,
  HermesPortableOllamaRecoveryPhaseError,
  recoverHermesPortableOllamaInference,
  type HermesPortableOllamaRecoveryFailure,
  type HermesPortableOllamaRecoveryPhase,
} from "../../../onboard/experimental/hermes-portable-ollama-inference";
import type { SandboxEntry } from "../../../state/registry";
import {
  captureHermesPortableInferenceRecoveryGateway,
  type HermesPortableActiveLifecycleAuthority,
} from "../gateway-state";

export interface HermesPortableInferenceConnectRecoveryInput {
  readonly sandboxName: string;
  readonly authority: HermesPortableActiveLifecycleAuthority;
  readonly readRegistry: (sandboxName: string) => SandboxEntry | null;
  readonly verifyRoute: () => SandboxEntry;
}

export type HermesPortableInferenceConnectRecoveryFailure =
  | HermesPortableOllamaRecoveryFailure
  | HermesPortableOllamaRecoveryPhase
  | "recovery-failed";

/** Reduce every recovery failure to one closed class without exposing nested diagnostics. */
export function classifyHermesPortableInferenceConnectRecoveryFailure(
  error: unknown,
): HermesPortableInferenceConnectRecoveryFailure {
  if (error instanceof HermesPortableOllamaRecoveryError) return error.failure;
  if (error instanceof HermesPortableOllamaRecoveryPhaseError) return error.phase;
  return "recovery-failed";
}

/** Resume exact published Ollama authority for one probe-only connect operation. */
export function recoverHermesPortableInferenceForConnectProbe(
  input: HermesPortableInferenceConnectRecoveryInput,
) {
  return recoverHermesPortableOllamaInference({
    intent: "connect-probe-only",
    sandboxName: input.sandboxName,
    entry: input.authority.entry,
    runGatewayOpenshell: (args, options) =>
      captureHermesPortableInferenceRecoveryGateway(input.sandboxName, args, options),
    readRegistry: input.readRegistry,
    verifyRoute: input.verifyRoute,
  });
}
