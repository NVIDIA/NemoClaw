// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Preserve the "default sandbox" flag across a destructive recreate/rebuild.
 *
 * Default-marking is normally deferred to the finalization step so a cancelled
 * fresh onboard never leaves an unconfigured sandbox registered as default
 * (#4614). But a recreate/rebuild first removes the existing registry entry
 * (which clears the default pointer) and re-registers it without a default.
 * If the rebuild then fails before finalization, the sandbox the operator was
 * already using would silently stop being the default until a successful re-run.
 *
 * These helpers snapshot whether the sandbox was the default *before* it is torn
 * down, and restore that flag immediately after it is re-registered — so only a
 * genuinely new sandbox (which was never the default) stays deferred.
 */

/** True iff `sandboxName` is the current default — capture this before recreate tears it down. */
export function wasSandboxDefault(currentDefault: string | null, sandboxName: string): boolean {
  return currentDefault === sandboxName;
}

/** Re-apply the default flag after re-registration iff the sandbox held it beforehand. */
export function restoreDefaultAfterRecreate(
  setDefault: (sandboxName: string) => void,
  sandboxName: string,
  wasDefaultBeforeRecreate: boolean,
): void {
  if (wasDefaultBeforeRecreate) {
    setDefault(sandboxName);
  }
}
