// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const policies: typeof import("../policy") = require("../policy");
const { waitUntil }: typeof import("../core/wait") = require("../core/wait");

function waitForPolicyMutation(description: string, mutate: () => boolean | void): void {
  let lastError: Error | null = null;
  const success = waitUntil(() => {
    try {
      const result = mutate();
      if (result === false) {
        lastError = new Error(`${description} returned false`);
        return false;
      }
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;
      if (!error.message.includes("sandbox not found")) {
        throw err;
      }
      return false;
    }
  }, 10, 2000);

  if (!success) {
    throw lastError || new Error(`${description} timed out`);
  }
}

/**
 * Reconcile the sandbox's currently-applied preset list with the user's
 * target selection:
 *   - remove presets in `applied` but not in `target` (narrow)
 *   - apply presets in `target` but not in `applied` (widen)
 *   - leave unchanged presets untouched (no wasteful re-apply)
 */
function syncPresetSelection(
  sandboxName: string,
  applied: string[],
  target: string[],
  accessByName: Record<string, string> | null = null,
): void {
  const targetSet = new Set(target);
  const appliedSet = new Set(applied);
  const deselected = applied.filter((name) => !targetSet.has(name));
  const newlySelected = target.filter((name) => !appliedSet.has(name));

  for (const name of deselected) {
    waitForPolicyMutation(`removePreset(${name})`, () => policies.removePreset(sandboxName, name));
  }

  if (!accessByName) {
    const builtInPresetNames = new Set(policies.listPresets().map((preset) => preset.name));
    const builtInNewlySelected = newlySelected.filter((name) => builtInPresetNames.has(name));
    const remainingNewlySelected = newlySelected.filter((name) => !builtInPresetNames.has(name));

    if (builtInNewlySelected.length > 0 && remainingNewlySelected.length === 0) {
      waitForPolicyMutation(`applyPresets(${builtInNewlySelected.join(",")})`, () =>
        policies.applyPresets(sandboxName, builtInNewlySelected),
      );
      return;
    }

    for (const name of newlySelected) {
      waitForPolicyMutation(`applyPreset(${name})`, () => policies.applyPreset(sandboxName, name));
    }
    return;
  }

  for (const name of newlySelected) {
    const options = { access: accessByName[name] };
    waitForPolicyMutation(`applyPreset(${name})`, () =>
      policies.applyPreset(sandboxName, name, options),
    );
  }
}

export { syncPresetSelection, waitForPolicyMutation };
