// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

let interruptedStep: string | null = null;
let interrupted = false;

export function markOnboardInterrupted(stepName: string | null): void {
  if (interrupted) return;
  interrupted = true;
  interruptedStep = stepName;
}

export function isOnboardInterrupted(): boolean {
  return interrupted;
}

export function onboardInterruptedStep(): string | null {
  return interruptedStep;
}

export function resetOnboardInterruptForTests(): void {
  interrupted = false;
  interruptedStep = null;
}
