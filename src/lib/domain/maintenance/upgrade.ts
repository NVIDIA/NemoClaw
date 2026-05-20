// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { UpgradeSandboxesOptions } from "../lifecycle/options";

export type SandboxVersionCheck = {
  isStale: boolean;
  sandboxVersion?: string | null;
  expectedVersion?: string | null;
  detectionMethod?: string | null;
};

export type UpgradeSandboxCandidate = {
  name: string;
  current?: string | null;
  expected?: string | null;
  running: boolean;
};

export type UpgradeClassification = {
  stale: UpgradeSandboxCandidate[];
  unknown: UpgradeSandboxCandidate[];
};

export function shouldSkipUpgradeConfirmation(options: UpgradeSandboxesOptions): boolean {
  return options.auto === true || options.yes === true;
}

export function classifyUpgradeableSandboxes(
  sandboxes: Array<{ name: string }>,
  liveNames: ReadonlySet<string>,
  checkVersion: (name: string) => SandboxVersionCheck,
): UpgradeClassification {
  const stale: UpgradeSandboxCandidate[] = [];
  const unknown: UpgradeSandboxCandidate[] = [];
  for (const sandbox of sandboxes) {
    const versionCheck = checkVersion(sandbox.name);
    if (versionCheck.isStale) {
      stale.push({
        name: sandbox.name,
        current: versionCheck.sandboxVersion,
        expected: versionCheck.expectedVersion,
        running: liveNames.has(sandbox.name),
      });
    } else if (versionCheck.detectionMethod === "unavailable") {
      unknown.push({
        name: sandbox.name,
        expected: versionCheck.expectedVersion,
        running: liveNames.has(sandbox.name),
      });
    }
  }
  return { stale, unknown };
}

export function splitRebuildableSandboxes(stale: UpgradeSandboxCandidate[]): {
  rebuildable: UpgradeSandboxCandidate[];
  stopped: UpgradeSandboxCandidate[];
} {
  const rebuildable: UpgradeSandboxCandidate[] = [];
  const stopped: UpgradeSandboxCandidate[] = [];
  for (const sandbox of stale) {
    if (sandbox.running) {
      rebuildable.push(sandbox);
    } else {
      stopped.push(sandbox);
    }
  }
  return { rebuildable, stopped };
}
