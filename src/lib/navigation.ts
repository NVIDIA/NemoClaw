// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const BACK_TO_SELECTION = Object.freeze({ kind: "NEMOCLAW_BACK_TO_SELECTION" });
export type BackToSelection = typeof BACK_TO_SELECTION;

export function isBackToSelection(value: unknown): value is BackToSelection {
  return value === BACK_TO_SELECTION;
}

export const NAVIGATION_HINT = "  Enter b to go back, or exit to quit.";

export function printNavigationHint(log: (message?: string) => void = console.log): void {
  log(NAVIGATION_HINT);
}
