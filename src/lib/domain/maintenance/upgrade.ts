// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { UpgradeSandboxesOptions } from "../lifecycle/options";

export type SandboxVersionCheck = {
  isStale: boolean;
  sandboxVersion?: string | null;
  expectedVersion?: string | null;
  detectionMethod?: string | null;
};

/**
 * Why a sandbox is classified as needing an upgrade. A sandbox can be stale
 * because its agent version is behind (`agent-version`), because the NemoClaw
 * build that produced its image differs from the running NemoClaw
 * (`image-drift`), or both (#5026).
 */
export type UpgradeStaleReason = "agent-version" | "image-drift";

export type UpgradeSandboxCandidate = {
  name: string;
  current?: string | null;
  expected?: string | null;
  running: boolean;
  // Present on stale candidates: the reasons the sandbox needs a rebuild.
  reasons?: UpgradeStaleReason[];
  // NemoClaw build fingerprint comparison, set only for `image-drift`.
  // `imageCurrent` is the build recorded on the sandbox (null when it predates
  // fingerprinting); `imageExpected` is the running NemoClaw build.
  imageCurrent?: string | null;
  imageExpected?: string | null;
};

export type UpgradeClassification = {
  stale: UpgradeSandboxCandidate[];
  unknown: UpgradeSandboxCandidate[];
};

export interface ClassifyUpgradeOptions {
  /**
   * Running NemoClaw build fingerprint, used to detect image drift (#5026).
   * When null/undefined, image-drift detection is disabled and only the agent
   * version is considered (legacy behavior).
   */
  currentNemoclawVersion?: string | null;
}

export function shouldSkipUpgradeConfirmation(options: UpgradeSandboxesOptions): boolean {
  return options.auto === true || options.yes === true;
}

/**
 * Whether the NemoClaw build recorded on a sandbox differs from the running
 * build. Drift requires POSITIVE evidence: a recorded fingerprint that differs
 * from the running build. Only NemoClaw-managed images carry a fingerprint, so
 * this never flags a custom-image (`--from`) sandbox — which `upgrade-sandboxes`
 * could otherwise rebuild onto the default image, losing the custom image. A
 * missing fingerprint is therefore treated as "not drifted": it is ambiguous
 * (a legacy managed image OR a legacy custom image, indistinguishable on disk),
 * so the sandbox opts into drift detection once it is rebuilt and gains a
 * fingerprint. Detection is also disabled when the running build is unknown.
 * (#5026)
 */
export function isNemoclawImageStale(
  recorded: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (!current) return false;
  if (!recorded) return false;
  return recorded !== current;
}

export function classifyUpgradeableSandboxes(
  sandboxes: Array<{ name: string; nemoclawVersion?: string | null }>,
  liveNames: ReadonlySet<string>,
  checkVersion: (name: string) => SandboxVersionCheck,
  options: ClassifyUpgradeOptions = {},
): UpgradeClassification {
  const currentNemoclawVersion = options.currentNemoclawVersion ?? null;
  const stale: UpgradeSandboxCandidate[] = [];
  const unknown: UpgradeSandboxCandidate[] = [];
  for (const sandbox of sandboxes) {
    const versionCheck = checkVersion(sandbox.name);
    const reasons: UpgradeStaleReason[] = [];
    if (versionCheck.isStale) reasons.push("agent-version");
    const imageStale = isNemoclawImageStale(sandbox.nemoclawVersion, currentNemoclawVersion);
    if (imageStale) reasons.push("image-drift");

    if (reasons.length > 0) {
      stale.push({
        name: sandbox.name,
        current: versionCheck.sandboxVersion,
        expected: versionCheck.expectedVersion,
        running: liveNames.has(sandbox.name),
        reasons,
        ...(imageStale
          ? {
              imageCurrent: sandbox.nemoclawVersion ?? null,
              imageExpected: currentNemoclawVersion,
            }
          : {}),
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
