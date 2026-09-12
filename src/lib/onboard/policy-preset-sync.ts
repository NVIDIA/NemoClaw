// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const policies: typeof import("../policy") = require("../policy");
const { waitUntilAsync }: typeof import("../core/wait") = require("../core/wait");

async function waitForPolicyMutation(
  description: string,
  mutate: () => boolean | void | Promise<boolean | void>,
): Promise<void> {
  let lastError: Error | null = null;
  const success = await waitUntilAsync(
    async () => {
      try {
        const result = await mutate();
        if (result === false) {
          throw new Error(`${description} returned false`);
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
    },
    10,
    2000,
  );

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
async function syncPresetSelection(
  sandboxName: string,
  applied: string[],
  target: string[],
  accessByName: Record<string, string> | null = null,
): Promise<void> {
  const targetSet = new Set(target);
  const appliedSet = new Set(applied);
  const deselected = applied.filter((name) => !targetSet.has(name));
  const newlySelected = target.filter((name) => !appliedSet.has(name));

  for (const name of deselected) {
    await waitForPolicyMutation(
      `removePreset(${name})`,
      async () => await policies.removePreset(sandboxName, name),
    );
  }

  if (!accessByName) {
    const builtInPresetNames = new Set(policies.listPresets().map((preset) => preset.name));
    const builtInNewlySelected = newlySelected.filter((name) => builtInPresetNames.has(name));
    const remainingNewlySelected = newlySelected.filter((name) => !builtInPresetNames.has(name));

    if (builtInNewlySelected.length > 0 && remainingNewlySelected.length === 0) {
      await waitForPolicyMutation(
        `applyPresets(${builtInNewlySelected.join(",")})`,
        async () => await policies.applyPresets(sandboxName, builtInNewlySelected),
      );
      return;
    }

    for (const name of newlySelected) {
      await waitForPolicyMutation(
        `applyPreset(${name})`,
        async () => await policies.applyPreset(sandboxName, name),
      );
    }
    return;
  }

  for (const name of newlySelected) {
    const options = { access: accessByName[name] };
    await waitForPolicyMutation(
      `applyPreset(${name})`,
      async () => await policies.applyPreset(sandboxName, name, options),
    );
  }
}

export { syncPresetSelection, waitForPolicyMutation };
