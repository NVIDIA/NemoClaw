// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type LegacyStepMutationModule = {
  LEGACY_MACHINE_STEP_MUTATION_OPTIONS: object;
};

type LegacyStepSessionModule = {
  markStepStarted(stepName: string, options?: object): unknown;
  markStepComplete(stepName: string, updates?: unknown, options?: object): unknown;
  markStepFailed(stepName: string, message?: string | null, options?: object): unknown;
};

export function markStepStartedLegacy<SessionModule extends LegacyStepSessionModule>(
  session: SessionModule,
  stepMutation: LegacyStepMutationModule,
  stepName: string,
): ReturnType<SessionModule["markStepStarted"]> {
  return session.markStepStarted(
    stepName,
    stepMutation.LEGACY_MACHINE_STEP_MUTATION_OPTIONS,
  ) as ReturnType<SessionModule["markStepStarted"]>;
}

export function markStepCompleteLegacy<SessionModule extends LegacyStepSessionModule>(
  session: SessionModule,
  stepMutation: LegacyStepMutationModule,
  stepName: string,
  updates?: Parameters<SessionModule["markStepComplete"]>[1],
): ReturnType<SessionModule["markStepComplete"]> {
  return session.markStepComplete(
    stepName,
    updates,
    stepMutation.LEGACY_MACHINE_STEP_MUTATION_OPTIONS,
  ) as ReturnType<SessionModule["markStepComplete"]>;
}

export function markStepFailedLegacy<SessionModule extends LegacyStepSessionModule>(
  session: SessionModule,
  stepMutation: LegacyStepMutationModule,
  stepName: string,
  message: string | null = null,
): ReturnType<SessionModule["markStepFailed"]> {
  return session.markStepFailed(
    stepName,
    message,
    stepMutation.LEGACY_MACHINE_STEP_MUTATION_OPTIONS,
  ) as ReturnType<SessionModule["markStepFailed"]>;
}
